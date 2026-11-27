import { expect, it, vi } from 'vitest'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import type { DaemonHandlerDeps } from './index'
import { laneSelfHandlers } from './lane-self'

const lane = {
  ref: 'host:h1/lane:L1',
  sessionId: 's1',
  title: 'Mine',
  cwd: '/work',
  busy: false,
  controller: null,
  controlFence: 1,
}
const agent = { kind: 'agent', laneRef: lane.ref, sessionId: 's1', unattended: false, lineage: 0 }
const surface = { kind: 'surface', clientId: 'ui', label: 'Phosphor', via: 'owner', caps: [] }
const ctx = (principal: object, over: Partial<OpHandlerContext> = {}) =>
  ({
    principal,
    reason: 'tidy',
    lane,
    signal: new AbortController().signal,
    log: () => {},
    ...over,
  }) as unknown as OpHandlerContext

function harness(sessionId: string | null = 's1') {
  const marks = {
    pinned: undefined as boolean | undefined,
    marker: undefined as string | undefined,
  }
  const runtime = {
    command: vi.fn(async () => ({ success: true })),
    mcpControl: vi.fn(async () => ({ ok: true as const, report: {} as never, inspectedAt: 1 })),
    summaryFor: vi.fn(() => null),
    publishSummary: vi.fn(),
  }
  const store = {
    getLane: vi.fn(() => ({
      ...marks,
      removedAt: null,
      sessionFile: null,
      title: lane.title,
      control: { fence: lane.controlFence, controller: null },
    })),
    setLaneMarks: vi.fn((_id: string, change: { pinned?: boolean; marker?: string }) =>
      Object.assign(marks, change),
    ),
  }
  const deps = {
    store,
    laneRuntime: runtime,
    daemonLanes: { sessionFor: () => sessionId },
  } as unknown as DaemonHandlerDeps
  return { handlers: laneSelfHandlers(deps), runtime, store, marks }
}

it('pins and marks the lane in the Host store, keeps the marker as given, and republishes', async () => {
  const h = harness()
  expect(await h.handlers['lane.pin']!({ on: true }, ctx(agent))).toEqual({
    text: 'Pinned lane.',
    before: { ref: lane.ref, on: false },
  })
  expect(await h.handlers['lane.marker']!({ marker: 'none' }, ctx(agent))).toMatchObject({
    before: undefined,
  })
  expect(h.store.setLaneMarks).toHaveBeenLastCalledWith('L1', { marker: 'none' })
  expect(await h.handlers['lane.marker']!({ marker: '🔥' }, ctx(agent))).toMatchObject({
    before: { ref: lane.ref, marker: 'none' },
  })
  expect(h.runtime.publishSummary).toHaveBeenCalledTimes(3)
})

it('renames a live lane through pi and refuses an unsaved stopped one', async () => {
  const h = harness()
  expect(await h.handlers['lane.rename']!({ name: 'Next' }, ctx(agent))).toEqual({
    text: 'Renamed lane to Next.',
    before: { ref: lane.ref, name: 'Mine', controlFence: lane.controlFence },
  })
  expect(h.runtime.command).toHaveBeenCalledWith('s1', { type: 'set_session_name', name: 'Next' })
  await expect(
    harness(null).handlers['lane.rename']!(
      { name: 'x' },
      ctx(agent, { lane: { ...lane, sessionId: null } }),
    ),
  ).rejects.toMatchObject({
    code: 'unavailable',
    message: 'This lane has no saved conversation yet.',
  })
})

it('answers the asking lane’s own context files as an effect, a surface’s through the lane', async () => {
  const h = harness()
  expect(await h.handlers['contextFiles.set']!({ claude: false }, ctx(agent))).toEqual({
    text: 'claude=off',
    effects: [{ kind: 'contextFiles', args: 'claude=off' }],
  })
  expect(h.runtime.command).not.toHaveBeenCalled()
  expect(await h.handlers['contextFiles.set']!({ agents: true }, ctx(surface))).toEqual({
    text: 'agents=on',
  })
  expect(h.runtime.command).toHaveBeenCalledWith('s1', {
    type: 'prompt',
    message: '/phosphor-context-files agents=on',
  })
})

it('inspects a lane’s connector through the session service and says why it cannot', async () => {
  const h = harness()
  const args = { server: 'github', action: 'inspect' }
  expect(await h.handlers['mcp.lane']!(args, ctx(surface))).toMatchObject({ data: { ok: true } })
  expect(h.runtime.mcpControl).toHaveBeenCalledWith('s1', 'github', 'inspect')
  h.runtime.mcpControl.mockResolvedValueOnce({
    ok: false,
    unsupported: true,
    message: 'old pi',
  } as never)
  await expect(h.handlers['mcp.lane']!(args, ctx(surface))).rejects.toMatchObject({
    code: 'unsupported',
    message: 'old pi',
  })
})

it('leaves a reload for after the run, and suggests a view as a notify link', async () => {
  const h = harness()
  expect(await h.handlers['lane.reload']!({}, ctx(agent, { reason: 'new rules\nmore' }))).toEqual({
    text: 'Reloading the lane: new rules.',
    deferred: [{ kind: 'reload', what: 'new rules' }],
  })
  expect(await h.handlers['ui.open']!({ target: 'settings/agent' }, ctx(agent))).toEqual({
    text: 'Suggested phosphor://settings/agent.',
    effects: [
      {
        kind: 'notify',
        message: 'Agent suggests opening phosphor://settings/agent',
        level: 'info',
      },
    ],
  })
})
