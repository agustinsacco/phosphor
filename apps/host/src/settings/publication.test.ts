import { afterEach, expect, it, vi } from 'vitest'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { domainHandlers, type DaemonHandlerDeps } from '../ops/handlers'
import {
  removeSettingsFixtures,
  settingsServiceFixture,
} from './__fixtures__/settings-service.fixture'

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
  expect(
    await f.patch(
      'agent',
      { type: 'agent.patch', patch: { retry: { enabled: false } } },
      agent.revision,
    ),
  ).toMatchObject({ ok: true })
  await handlers['mcp.add']!(
    { scope: 'global', name: 'fixture', config: { url: 'https://example.test' } },
    context,
  )
  const connectors = await f.read('connectors')
  expect(connectors.connectors?.servers.map((server) => server.name)).toEqual(['fixture'])
  expect(
    await f.patch('connectors', { type: 'mcp.remove', name: 'fixture' }, connectors.revision),
  ).toMatchObject({ ok: true })
  expect(changed.mock.calls).toEqual(
    ['settings', 'settings', 'connectors', 'connectors'].map((kind) => [{ kind }]),
  )
})

it.each(['agent', 'ui'] as const)('publishes committed instructions from %s', async (mode) => {
  const changed = vi.fn()
  const f = await settingsServiceFixture(changed)
  const before = await f.read('instructions')
  if (mode === 'agent') {
    const handlers = domainHandlers({ settingsOps: { settings: f.settings } } as DaemonHandlerDeps)
    await handlers['instructions.edit']!(
      { revision: before.revision, content: 'New instructions' },
      { signal: new AbortController().signal } as OpHandlerContext,
    )
  } else {
    expect(
      await f.patch(
        'instructions',
        { type: 'instructions.write', content: 'New instructions' },
        before.revision,
      ),
    ).toMatchObject({ ok: true })
  }
  expect((await f.read('instructions')).instructions).toMatchObject({ content: 'New instructions' })
  expect(changed).toHaveBeenCalledExactlyOnceWith({ kind: 'settings' })
})
