import { afterEach, expect, it, vi } from 'vitest'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { domainHandlers, type DaemonHandlerDeps } from '../ops/handlers'
import { removeSettingsFixtures, settingsServiceFixture } from './__fixtures__/settings-service.fixture'

afterEach(removeSettingsFixtures)

it('publishes settings and connector changes through both their UI and catalog paths', async () => {
  const changed = vi.fn()
  const f = await settingsServiceFixture(changed)
  const handlers = domainHandlers({
    settingsOps: { settings: f.settings },
    lanes: { calls: { call: f.settings.feature.call } },
  } as unknown as DaemonHandlerDeps)
  const context = {
    signal: new AbortController().signal,
    principal: { kind: 'agent', laneRef: 'fixture', lineage: 0 },
  } as OpHandlerContext
  await handlers['settings.set']!({ key: 'retry.enabled', value: true }, context)
  const agent = await f.read('agent')
  expect(agent.agent?.retry?.enabled).toBe(true)
  expect(await f.patch('agent', { type: 'agent.patch', patch: { retry: { enabled: false } } }, agent.revision)).toMatchObject({ ok: true })
  await handlers['mcp.add']!({ scope: 'global', name: 'fixture', config: { url: 'https://example.test' } }, context)
  const connectors = await f.read('connectors')
  expect(connectors.connectors?.servers.map((server) => server.name)).toEqual(['fixture'])
  expect(await f.patch('connectors', { type: 'mcp.remove', name: 'fixture' }, connectors.revision)).toMatchObject({ ok: true })
  expect(changed.mock.calls).toEqual(
    ['settings', 'settings', 'connectors', 'connectors'].map((kind) => [{ kind }]),
  )
})
