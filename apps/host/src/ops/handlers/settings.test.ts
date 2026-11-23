import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  settingsServiceFixture,
  removeSettingsFixtures,
} from '../../settings/__fixtures__/settings-service.fixture'
import { domainHandlers, type DaemonHandlerDeps } from './index'

afterEach(removeSettingsFixtures)
async function fixture() {
  const f = await settingsServiceFixture()
  const call = vi.fn(f.settings.feature.call)
  const deps = {
    settingsOps: { settings: f.settings },
    store: { listRepositories: () => [f.repository] },
    lanes: { calls: { call } },
  } as unknown as DaemonHandlerDeps
  const handlers = domainHandlers(deps)
  const ctx = { signal: new AbortController().signal, lane: { cwd: f.repo } } as never
  return { ...f, call, run: (op: string, args: unknown) => handlers[op]!(args, ctx) }
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
