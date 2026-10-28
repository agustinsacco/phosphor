import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostConnectionView, HostLaneView } from '@shared/ipc'
import { HOST_TOO_OLD } from '@shared/host-protocol-repositories'
import { hostResourceKey } from '@shared/remote-host'
import { useExtensionUiStore } from './extensionUi'
import { useRemoteLanesStore } from './remoteLanes'
import { migrateLegacyLaneMarks, setRemoteLaneMarks } from './remoteLaneMarks'
import { useSessionsStore } from './sessions'

const invoke = vi.fn()
let prefs: { pinnedSessions: string[]; laneMarkers: Record<string, string> }
let pushToast: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  prefs = { pinnedSessions: [], laneMarkers: {} }
  invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === 'app:getPrefs') return structuredClone(prefs)
    return undefined
  })
  vi.stubGlobal('window', { phosphor: { invoke } })
  useSessionsStore.setState({ pinned: [], laneMarkers: {} })
  useRemoteLanesStore.setState({ hosts: {} })
  pushToast = vi.spyOn(useExtensionUiStore.getState(), 'pushToast')
  pushToast.mockClear()
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const key = (hostId: string, laneId: string) =>
  hostResourceKey({ kind: 'remote', hostId }, 'session', laneId)
function lane(laneId: string, marks: Partial<HostLaneView> = {}): HostLaneView {
  return {
    laneId,
    repositoryId: '0000000000000001',
    cwd: '/remote/demo',
    title: 'Lane',
    branch: null,
    worktree: false,
    model: null,
    activity: 'idle',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    attention: 0,
    read: 0,
    control: { fence: 1, controller: null },
    ...marks,
  }
}
function host(lanes: HostLaneView[], fields: Partial<HostConnectionView> = {}): HostConnectionView {
  return {
    connectionToken: 'connection',
    state: 'ready',
    laneMarks: true,
    capabilities: ['sessions.read', 'sessions.control'],
    repositories: [],
    lanes,
    ...fields,
  }
}
const setCalls = () => invoke.mock.calls.filter(([channel]) => channel === 'hosts:setLaneMarks')

describe('setRemoteLaneMarks', () => {
  it('asks the Host to change the lane’s marks', async () => {
    expect(await setRemoteLaneMarks('h', 'l', { pinned: true })).toBe(true)
    expect(invoke).toHaveBeenCalledWith('hosts:setLaneMarks', 'h', 'l', { pinned: true })
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('says to update an older Host, and otherwise that the change was not saved', async () => {
    invoke.mockRejectedValueOnce(new Error(`Error invoking remote method: ${HOST_TOO_OLD}`))
    expect(await setRemoteLaneMarks('h', 'l', { marker: '🦊' })).toBe(false)
    expect(pushToast).toHaveBeenLastCalledWith(
      `Pins and lane markers need a newer Host. ${HOST_TOO_OLD}`,
      'error',
    )
    invoke.mockRejectedValueOnce(new Error('Not available on remote lanes yet.'))
    expect(await setRemoteLaneMarks('h', 'l', { marker: null })).toBe(false)
    expect(pushToast).toHaveBeenLastCalledWith(
      'The Host could not save this pin or marker. Try again.',
      'error',
    )
  })
})

describe('legacy Desktop marks migration', () => {
  it('moves local pins and markers of unmarked Host lanes to the Host, once per Host', async () => {
    const hostId = randomUUID()
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()]
    prefs = {
      pinnedSessions: [key(hostId, a), key(hostId, c), '/local/session.jsonl'],
      laneMarkers: { [key(hostId, a)]: '🦊', [key(hostId, b)]: '' },
    }
    const view = host([lane(a), lane(b), lane(c, { pinned: true })])
    migrateLegacyLaneMarks({ [hostId]: view })
    await flush()
    expect(setCalls()).toEqual([
      ['hosts:setLaneMarks', hostId, a, { pinned: true, marker: '🦊' }],
      ['hosts:setLaneMarks', hostId, b, { marker: '' }],
    ])
    expect(useSessionsStore.getState().pinned).toEqual(['/local/session.jsonl'])
    expect(useSessionsStore.getState().laneMarkers).toEqual({})
    expect(invoke).toHaveBeenCalledWith('app:setPinnedSessions', ['/local/session.jsonl'])
    expect(invoke).toHaveBeenCalledWith('app:setLaneMarkers', {})
    invoke.mockClear()
    migrateLegacyLaneMarks({ [hostId]: view })
    await flush()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps a legacy entry the Host did not accept, and waits for a Host that supports marks', async () => {
    const hostId = randomUUID()
    const laneId = randomUUID()
    prefs = { pinnedSessions: [key(hostId, laneId)], laneMarkers: {} }
    migrateLegacyLaneMarks({ [hostId]: host([lane(laneId)], { laneMarks: undefined }) })
    migrateLegacyLaneMarks({ [hostId]: host([lane(laneId)], { state: 'reconnecting' }) })
    await flush()
    expect(invoke).not.toHaveBeenCalled()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'app:getPrefs') return structuredClone(prefs)
      if (channel === 'hosts:setLaneMarks') throw new Error('refused')
      return undefined
    })
    migrateLegacyLaneMarks({ [hostId]: host([lane(laneId)]) })
    await flush()
    expect(setCalls()).toHaveLength(1)
    expect(useSessionsStore.getState().pinned).toEqual([key(hostId, laneId)])
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('runs when the remote lanes snapshot shows a ready Host', async () => {
    const hostId = randomUUID()
    const laneId = randomUUID()
    prefs = { pinnedSessions: [], laneMarkers: { [key(hostId, laneId)]: '🚀' } }
    useRemoteLanesStore.setState({ hosts: { [hostId]: host([lane(laneId)]) } })
    await flush()
    expect(setCalls()).toEqual([['hosts:setLaneMarks', hostId, laneId, { marker: '🚀' }]])
  })
})
