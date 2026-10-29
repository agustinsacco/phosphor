import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostFrame, LaneSummary, Receipt } from '@phosphor/shared/host-protocol'
import { HOST_TOO_OLD } from '@phosphor/shared/host-protocol-repositories'
import type { HostConnectionSnapshot } from './connection'
import { LANE_MARKS_UNCONFIRMED, laneMarks } from './lane-marks'
import { REMOTE_UNAVAILABLE } from './lane-ops'
import { readyView } from './ready-view'

const laneId = '12345678-1234-4234-8234-123456789abc'
const lane = { laneId, control: { fence: 4, controller: null } } as unknown as LaneSummary
let view: HostConnectionSnapshot, generation: number
const send = vi.fn<(...args: unknown[]) => Promise<Receipt>>()
const c = {
  snapshot: () => view,
  incarnation: () => ({ generation, runtimeEpoch: '0000000000000001' }),
  send,
}
let connected: typeof c | undefined
const marks = laneMarks(() => connected)
beforeEach(() => {
  connected = c
  generation = 1
  view = {
    connectionToken: 'test',
    state: 'ready',
    laneMarks: true,
    capabilities: ['sessions.read', 'sessions.control'],
    repositories: [],
    lanes: [lane],
  }
  send.mockReset().mockResolvedValue({ requestId: laneId, status: 'done' })
})

describe('laneMarks', () => {
  it('sends one unfenced lane.marks op on the lane', async () => {
    await marks.set('host', laneId, { pinned: true, marker: null })
    expect(send).toHaveBeenCalledWith({ type: 'lane.marks', pinned: true, marker: null }, laneId)
    await marks.set('host', laneId, { marker: '' })
    expect(send).toHaveBeenLastCalledWith({ type: 'lane.marks', marker: '' }, laneId)
  })

  it('tells the person to update an older Host that answers unsupported', async () => {
    send.mockResolvedValueOnce({ requestId: laneId, status: 'rejected', code: 'unsupported' })
    await expect(marks.set('host', laneId, { pinned: true })).rejects.toThrow(HOST_TOO_OLD)
    send.mockResolvedValueOnce({ requestId: laneId, status: 'rejected', code: 'forbidden' })
    await expect(marks.set('host', laneId, { pinned: true })).rejects.toThrow(
      LANE_MARKS_UNCONFIRMED,
    )
    send.mockResolvedValueOnce({ requestId: laneId, status: 'unknown' })
    await expect(marks.set('host', laneId, { pinned: true })).rejects.toThrow(
      LANE_MARKS_UNCONFIRMED,
    )
  })

  it('refuses an invalid change, an unlisted lane and a Host without control', async () => {
    for (const change of [{}, { marker: 'a\nb' }, { pinned: 'yes' }, { pinned: true, x: 1 }])
      await expect(marks.set('host', laneId, change as never)).rejects.toThrow()
    await expect(
      marks.set('host', '22345678-1234-4234-8234-123456789abc', { pinned: true }),
    ).rejects.toThrow(REMOTE_UNAVAILABLE)
    view.capabilities = ['sessions.read']
    await expect(marks.set('host', laneId, { pinned: true })).rejects.toThrow(REMOTE_UNAVAILABLE)
    connected = undefined
    await expect(marks.set('host', laneId, { pinned: true })).rejects.toThrow(REMOTE_UNAVAILABLE)
    expect(send).not.toHaveBeenCalled()
  })

  it('does not trust a reply from a replaced connection', async () => {
    send.mockImplementationOnce(async () => {
      generation++
      return { requestId: laneId, status: 'done' }
    })
    await expect(marks.set('host', laneId, { pinned: true })).rejects.toThrow(REMOTE_UNAVAILABLE)
  })
})

describe('readyView', () => {
  const ready = {
    type: 'ready',
    protocolVersion: 1,
    hello: { hostVersion: '1.0.0' },
    capabilities: ['sessions.read'],
  } as unknown as Extract<HostFrame, { type: 'ready' }>
  it('reports lane marks support only when the Host says so', () => {
    expect(readyView({ ...ready, laneMarks: true }).laneMarks).toBe(true)
    expect(readyView(ready).laneMarks).toBe(false)
  })
})
