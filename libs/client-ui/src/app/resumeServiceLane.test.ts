import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostConnectionView } from '@phosphor/shared/ipc'
import type * as RemoteLanes from '../stores/remoteLanes'

const open = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../stores/remoteLanes', async (original) => ({
  ...(await original<typeof RemoteLanes>()),
  openRemoteLane: open,
}))

import { useRemoteLanesStore } from '../stores/remoteLanes'
import { useSessionsStore } from '../stores/sessions'
import { resumeServiceLane } from './resumeServiceLane'

const HOST = 'machine-1'
const view = (state: string, laneIds: string[]) =>
  ({
    state,
    capabilities: [],
    lanes: laneIds.map((laneId) => ({ laneId })),
  }) as unknown as HostConnectionView

beforeEach(() => {
  vi.useFakeTimers()
  open.mockClear()
  useRemoteLanesStore.setState({ hosts: {} })
})
afterEach(() => vi.useRealTimers())

describe('resuming This Mac’s last service lane', () => {
  it('waits for the service to list the lane, then opens it', async () => {
    const resumed = resumeServiceLane(HOST, 'lane-a', () => false)
    useRemoteLanesStore.setState({ hosts: { [HOST]: view('connecting', []) } })
    useRemoteLanesStore.setState({ hosts: { [HOST]: view('ready', []) } })
    expect(open).not.toHaveBeenCalled()
    useRemoteLanesStore.setState({ hosts: { [HOST]: view('ready', ['lane-a']) } })
    expect(await resumed).toBe(true)
    expect(open).toHaveBeenCalledWith(HOST, 'lane-a')
  })

  it('opens at once when the lane is already listed', async () => {
    useRemoteLanesStore.setState({ hosts: { [HOST]: view('ready', ['lane-a']) } })
    expect(await resumeServiceLane(HOST, 'lane-a', () => false)).toBe(true)
  })

  it('waits out a slow service: the lane may appear well after 10 s', async () => {
    const slow = resumeServiceLane(HOST, 'lane-a', () => false)
    await vi.advanceTimersByTimeAsync(20_000)
    useRemoteLanesStore.setState({ hosts: { [HOST]: view('ready', ['lane-a']) } })
    expect(await slow).toBe(true)
  })

  it('never takes you away from somewhere you went while it waited', async () => {
    const waiting = resumeServiceLane(HOST, 'lane-a', () => false)
    useSessionsStore.getState().claimNav()
    useRemoteLanesStore.setState({ hosts: { [HOST]: view('ready', ['lane-a']) } })
    expect(await waiting).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('gives up quietly when the lane never appears, or launch moved on', async () => {
    const late = resumeServiceLane(HOST, 'lane-a', () => false)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(await late).toBe(false)
    let cancelled = false
    const moved = resumeServiceLane(HOST, 'lane-a', () => cancelled)
    cancelled = true
    useRemoteLanesStore.setState({ hosts: { [HOST]: view('ready', ['lane-a']) } })
    expect(await moved).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
