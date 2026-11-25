import { expect, it, vi } from 'vitest'
import { type LaneSummary } from '@phosphor/shared/host-protocol'
import type { createHostConnection, LaneFrame } from './connection'
import { createRemoteLanes } from './remote-lanes'

function setup() {
  const lane = { laneId: 'lane', activity: 'stopped', control: { fence: 1 } }
  let receive: (frame: LaneFrame) => void = () => {}
  const watchLane = vi.fn((_id: string, listen: typeof receive) => {
    receive = listen
    return () => {}
  })
  const c = {
    snapshot: () => ({ state: 'ready', capabilities: ['sessions.read'], lanes: [lane] }),
    watchLane,
  } as unknown as ReturnType<typeof createHostConnection>
  const lanes = createRemoteLanes({
    connection: () => c,
    label: () => 'test',
    present: () => true,
    changed: () => {},
  })
  const send = vi.fn()
  const open = () => lanes.open({ id: 1, destroyed: () => false, send }, 'host', 'lane')
  return { lane, lanes, watchLane, send, open, receive: (frame: LaneFrame) => receive(frame) }
}

it('opens an oversized stopped preview and reattaches when the lane runs', async () => {
  const { lane, lanes, watchLane, send, open, receive } = setup()
  const opening = open()
  receive({ type: 'subscribe-failed', id: 'watch', code: 'too-large' })
  const info = await opening
  expect(info.laneId).toBe('lane')
  const stopped = await lanes.command(1, info.sessionId, { type: 'get_messages' })
  lanes.reconcile()
  expect(watchLane).toHaveBeenCalledTimes(1)
  lane.activity = 'idle'
  lanes.reconcile()
  lanes.reconcile()
  expect(watchLane).toHaveBeenCalledTimes(2)
  // An older Host can refuse the live snapshot, too. Do not discard the handle,
  // report a pi exit, or retry on every subsequent listing change.
  receive({ type: 'subscribe-failed', id: 'watch', code: 'too-large' })
  expect(lanes.list(1)).toEqual([info])
  expect(stopped).toMatchObject({
    success: false,
    messagesUnavailable: true,
    error: 'This conversation is too large to preview.',
  })
  expect(await lanes.command(1, info.sessionId, { type: 'get_messages' })).toEqual(stopped)
  lanes.reconcile()
  expect(watchLane).toHaveBeenCalledTimes(2)
  expect(send).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ kind: 'exit' }),
  )
  lanes.clear()
})

it('delivers the live turn without history and clears the notice on a complete reset', async () => {
  const { lane, lanes, watchLane, send, open, receive } = setup()
  lane.activity = 'idle'
  const opening = open()
  const frame = {
    type: 'snapshot' as const,
    id: 'watch',
    laneId: 'lane',
    reset: true,
    snapshot: {
      summary: lane as LaneSummary,
      cursor: { epoch: 'epoch', seq: 1 },
      state: null,
      messages: [],
      pending: [],
      dialogs: [],
      ui: [],
    },
  }
  const event = { type: 'agent_start' as const }
  receive({
    ...frame,
    snapshot: { ...frame.snapshot, messagesUnavailable: true, pending: [event] },
  })
  const info = await opening
  const history = () => lanes.command(1, info.sessionId, { type: 'get_messages' })
  expect(await history()).toMatchObject({
    success: false,
    messagesUnavailable: true,
    error: 'This conversation is too large to preview.',
  })
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith(`pi:event:${info.sessionId}`, { kind: 'event', event }),
  )
  lanes.reconcile()
  expect(watchLane).toHaveBeenCalledTimes(1)
  const message = { role: 'user' as const, content: 'Fits again' }
  receive({ ...frame, snapshot: { ...frame.snapshot, messages: [message] } })
  expect(await history()).toMatchObject({ success: true, data: { messages: [message] } })
  lanes.clear()
})
