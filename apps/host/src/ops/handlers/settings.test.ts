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

it('never retargets private MCP fields to a different URL and never signs in or out', async () => {
  const f = await fixture()
  const file = join(f.agentDir, 'mcp.json')
  await writeFile(
    file,
    '{"mcpServers":{"sample":{"url":"https://example.test","headers":{"X-Fixture":"private-value"}}}}',
  )
  const request = { scope: 'global', name: 'sample', config: { url: 'https://other.test' } }
  await expect(f.run('mcp.update', request)).rejects.toThrow(/private/)
  expect(await readFile(file, 'utf8')).not.toContain('other.test')
  await f.run('mcp.add', { ...request, name: 'new' })
  await f.run('mcp.update', { ...request, name: 'new', config: { url: 'https://changed.test' } })
  expect(await readFile(file, 'utf8')).toContain('changed.test')
  await f.run('mcp.disable', { scope: 'global', name: 'new' })
  await f.run('mcp.remove', { scope: 'global', name: 'new' })
  expect(JSON.stringify(await f.run('mcp.list', {}))).not.toContain('private-value')
})
