import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { IPC_WEB } from '@phosphor/shared/ipc-web'
import type { RemoteLanes } from '@phosphor/host-client/remote-lanes'
import { createBrowserHandlers } from './handlers'
import { createBrowserResources } from './resources'
import type { BrowserHosts } from './hosts'

const laneId = '12345678-1234-4234-8234-123456789abc'

/* Pins and markers live on the Host, so the browser sets them over its own connection. */
function setup() {
  const host = randomUUID()
  const view = {
    state: 'ready',
    connectionToken: 'first',
    laneMarks: true,
    capabilities: ['sessions.read', 'sessions.control'],
    repositories: [],
    lanes: [{ laneId, control: { fence: 3, controller: null } }],
  }
  const send = vi.fn(async () => ({ requestId: randomUUID(), status: 'done' }))
  const connection = {
    snapshot: () => view,
    incarnation: () => ({ generation: 1, runtimeEpoch: '0000000000000001' }),
    call: vi.fn(),
    send,
  }
  const hosts = {
    connection: (id: string) => (id === host ? connection : undefined),
    snapshot: () => ({ [host]: view }),
    label: () => 'Studio',
    directoryReady: () => true,
  }
  const resources = createBrowserResources(
    hosts as unknown as BrowserHosts,
    { readLane: () => null } as unknown as RemoteLanes,
  )
  const proxy = new Proxy({}, { get: () => () => undefined })
  const handlers = createBrowserHandlers({
    ...{ control: proxy, lanes: proxy, prefs: proxy, drafts: proxy },
    hosts,
    resources,
    window: () => proxy,
    openExternal: () => {},
    broadcastLogout: () => {},
    machinesChanged: () => {},
  } as never) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  return { handlers, host, view, send }
}

it('admits Host-synced pins and markers in the browser', () => {
  expect(IPC_WEB['hosts:setLaneMarks'].kind).toBe('remote-supported')
})

it('sets a lane’s pin and marker over the Host connection, unfenced', async () => {
  const s = setup()
  await s.handlers['hosts:setLaneMarks']!(s.host, laneId, { pinned: true, marker: '🦊' })
  expect(s.send).toHaveBeenLastCalledWith(
    { type: 'lane.marks', pinned: true, marker: '🦊' },
    laneId,
  )
})

it('sends nothing while the Host is away or cannot control lanes', async () => {
  const s = setup()
  s.view.state = 'reconnecting'
  await expect(
    s.handlers['hosts:setLaneMarks']!(s.host, laneId, { pinned: true }),
  ).rejects.toThrow()
  s.view.state = 'ready'
  s.view.capabilities = ['sessions.read']
  await expect(
    s.handlers['hosts:setLaneMarks']!(s.host, laneId, { pinned: true }),
  ).rejects.toThrow()
  expect(s.send).not.toHaveBeenCalled()
})
