import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  settingsServiceFixture,
  removeSettingsFixtures,
} from '../../settings/__fixtures__/settings-service.fixture'
import { settingsAreCurrent } from './settings'
import { domainHandlers, type DaemonHandlerDeps } from './index'

afterEach(removeSettingsFixtures)
async function fixture() {
  const f = await settingsServiceFixture()
  const call = vi.fn(f.settings.feature.call)
  const refreshDirectives = vi.fn(async () => 0)
  const deps = {
    settingsOps: { settings: f.settings, refreshDirectives },
    store: { listRepositories: () => [f.repository] },
    lanes: { calls: { call } },
  } as unknown as DaemonHandlerDeps
  const handlers = domainHandlers(deps)
  const ctx = { signal: new AbortController().signal, lane: { cwd: f.repo } } as never
  return {
    ...f,
    call,
    deps,
    refreshDirectives,
    run: (op: string, args: unknown) => handlers[op]!(args, ctx),
  }
}

it('changes one nested default, returning the inverse without unrelated settings', async () => {
  const f = await fixture()
  await writeFile(
    join(f.agentDir, 'settings.json'),
    '{"retry":{"enabled":false,"baseDelayMs":500}}',
  )
  expect(await f.run('settings.set', { key: 'retry.enabled', value: true })).toMatchObject({
    before: { key: 'retry.enabled', value: false },
  })
  expect((await f.read('agent')).agent?.retry).toEqual({ enabled: true, baseDelayMs: 500 })
})
it('never starts a command server to satisfy a read-tier MCP check', async () => {
  const f = await fixture()
  await writeFile(join(f.agentDir, 'mcp.json'), '{"mcpServers":{"sample":{"command":"dummy"}}}')
  expect((await f.run('mcp.check', { name: 'sample' })).text).toMatch(/Settings/)
  expect(f.call.mock.calls.map(([method]) => method)).not.toContain('machine.settings.check')
})
it('returns only reviewed raw settings; rejects trust and secret keys even inside groups', async () => {
  const f = await fixture()
  const file = join(f.agentDir, 'settings.json')
  await writeFile(
    file,
    '{"hideThinkingBlock":true,"apiKey":"private-value","retry":{"enabled":true,"secret":"private-value"}}',
  )
  expect(JSON.stringify(await f.run('config.read', { file: 'settings' }))).not.toContain(
    'private-value',
  )
  for (const content of ['{"defaultProjectTrust":"always"}', '{"retry":{"secret":"bad"}}']) {
    await expect(f.run('config.write', { file: 'settings', content })).rejects.toMatchObject({
      code: 'forbidden',
    })
  }
  expect(await readFile(file, 'utf8')).toContain('private-value')
})

it('pushes a project directive only to lanes in the registered scope and preserves global defaults', async () => {
  const f = await fixture()
  await f.run('directives.set', { key: 'worktreeGuard', on: false, project: true })
  expect(f.refreshDirectives).toHaveBeenCalledWith(f.repo)
  expect((await f.read('agent')).agent?.agentDirectives?.worktreeGuard).toBe(true)
  expect((await f.read('agent', f.repository.id)).agent?.agentDirectives?.worktreeGuard).toBe(false)
})

it('refuses Undo after a later write to that field; unrelated changes do not block it', async () => {
  const f = await fixture()
  const a = { key: 'retry.enabled', value: true }
  const entry = { op: 'settings.set', undoRecord: { forward: a } } as never
  await f.run('settings.set', a)
  await f.run('settings.set', { key: 'retry.maxRetries', value: 8 })
  expect(await settingsAreCurrent(f.deps)(entry)).toBe(true)
  await f.run('settings.set', { ...a, value: false })
  expect(await settingsAreCurrent(f.deps)(entry)).toBe(false)
})

it('leaves OAuth sign-out and retargeting to the surface, but can edit metadata in place', async () => {
  const f = await fixture()
  const file = join(f.agentDir, 'mcp.json')
  const url = 'https://example.test'
  await writeFile(
    file,
    JSON.stringify({
      mcpServers: {
        sample: { url, oauth: { clientId: 'fixture' }, headers: { 'X-Fixture': 'private-value' } },
      },
    }),
  )
  const target = { scope: 'global', name: 'sample' }
  const refusal = {
    code: 'forbidden',
    message:
      'Remove or retarget this connector in Settings → Connectors; Phosphor signs it out there.',
  }
  await expect(
    f.run('mcp.update', { ...target, config: { url: 'https://other.test' } }),
  ).rejects.toMatchObject(refusal)
  await expect(f.run('mcp.remove', target)).rejects.toMatchObject(refusal)
  await f.run('mcp.update', { ...target, config: { url, description: 'Reviewed description' } })
  await f.run('mcp.disable', target)
  await f.run('mcp.enable', target)
  expect(await readFile(file, 'utf8')).toContain('private-value')
  expect(JSON.stringify(await f.run('mcp.list', {}))).not.toContain('private-value')
  expect(await readFile(file, 'utf8')).toContain('Reviewed description')
  expect(await readFile(file, 'utf8')).not.toContain('other.test')
  await f.run('mcp.add', { scope: 'global', name: 'command', config: { command: 'fixture' } })
  await f.run('mcp.remove', { scope: 'global', name: 'command' })
  expect(await readFile(file, 'utf8')).not.toContain('command')
})
