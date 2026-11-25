import { expect, it, vi } from 'vitest'
import type { createHostConnection, LaneFrame } from './connection'
import { createRemoteLanes } from './remote-lanes'

it('opens an oversized stopped preview and reattaches when the lane runs', async () => {
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
  const opening = lanes.open({ id: 1, destroyed: () => false, send: () => {} }, 'host', 'lane')
  receive({ type: 'subscribe-failed', id: 'watch', code: 'too-large' })
  const info = await opening
  expect(info.laneId).toBe('lane')
  expect(await lanes.command(1, info.sessionId, { type: 'get_messages' })).toMatchObject({
    success: false,
    error: 'This conversation is too large to preview while stopped. Resume to load it.',
  })
  lanes.reconcile()
  expect(watchLane).toHaveBeenCalledTimes(1)
  lane.activity = 'idle'
  lanes.reconcile()
  lanes.reconcile()
  expect(watchLane).toHaveBeenCalledTimes(2)
  lanes.clear()
})
