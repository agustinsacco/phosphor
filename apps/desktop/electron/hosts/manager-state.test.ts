import { expect, it, vi } from 'vitest'
import type { HostConnectionSnapshot } from './connection'
import { createHostConnection } from './connection'
import { createHostManagerState, hostManagerSnapshot } from './manager-state'

function view(): HostConnectionSnapshot {
  const lane = {
    laneId: 'lane',
    repositoryId: 'repository',
    cwd: '/workspace',
    title: null,
    branch: null,
    worktree: false,
    model: null,
    activity: 'idle' as const,
    createdAt: '',
    updatedAt: '',
    attention: 0,
    read: 0,
  }
  return {
    connectionToken: 'token',
    state: 'down',
    capabilities: [],
    repositories: [],
    lanes: [
      {
        ...lane,
        control: {
          fence: 2,
          controller: { clientId: 'self-secret', label: 'Me', connected: true },
        },
      },
      {
        ...lane,
        control: {
          fence: 3,
          controller: { clientId: 'other-secret', label: 'Other', connected: false },
        },
      },
      { ...lane, control: { fence: 4, controller: null } },
    ],
  }
}

it('clones cached snapshots and redacts controller identities while retaining self and fences', () => {
  const state = createHostManagerState('user-secret')
  state.cached.host = view()
  const snapshot = hostManagerSnapshot(state, { clientId: () => 'self-secret' })
  expect(JSON.stringify(snapshot)).not.toMatch(/user-secret|self-secret|other-secret/)
  expect(snapshot.host?.lanes.map((lane) => lane.control)).toEqual([
    { fence: 2, controller: { label: 'Me', connected: true, self: true } },
    { fence: 3, controller: { label: 'Other', connected: false, self: false } },
    { fence: 4, controller: null },
  ])
  snapshot.host!.lanes[0]!.control.fence = 99
  snapshot.host!.capabilities.length = 0
  expect(state.cached.host.lanes[0]?.control.fence).toBe(2)
  expect(snapshot.host?.capabilities).not.toBe(state.cached.host.capabilities)
})
it('prefers a live view over the cache and applies the same controller projection', () => {
  const state = createHostManagerState('user-secret')
  state.cached.host = { ...view(), connectionToken: 'old' }
  const connection = createHostConnection({
    hostId: 'host',
    endpoint: null,
    socket: async () => {
      throw new Error('offline')
    },
    grant: async () => {
      throw new Error('offline')
    },
    disabled: () => {},
    changed: () => {},
    clearGrant: () => {},
  })
  vi.spyOn(connection, 'snapshot').mockReturnValue({ ...view(), state: 'ready' })
  state.connections.set('host', { endpoint: null, connection })
  const snapshot = hostManagerSnapshot(state, { clientId: () => null })
  expect(snapshot.host?.connectionToken).toBe('token')
  expect(snapshot.host?.state).toBe('ready')
  expect(snapshot.host?.lanes[0]?.control.controller?.self).toBe(false)
  expect(JSON.stringify(snapshot)).not.toMatch(/user-secret|self-secret|other-secret/)
  connection.close()
})
it('creates independent connection, cache, list and lifecycle state for each manager', () => {
  const first = createHostManagerState('first'),
    second = createHostManagerState('second')
  first.cached.host = view()
  first.list = { machines: [], serverTime: '' }
  first.generation++
  first.disabled = true
  first.fetching = true
  first.again = true
  expect(second).toEqual(createHostManagerState('second'))
  expect(first.connections).not.toBe(second.connections)
  expect(first.cached).not.toBe(second.cached)
  expect(hostManagerSnapshot(second, { clientId: () => null })).toEqual({})
})
