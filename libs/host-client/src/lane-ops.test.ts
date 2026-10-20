import { describe, expect, it, vi } from 'vitest'
import type { LaneOp } from '@phosphor/shared/host-protocol'
import type { CommandResult } from './connection'
import { receiptResponse, sendToLane } from './lane-ops'

const LANE = 'f83d7d13-9111-43bf-847b-87b9db21e7d8'
const stopped: CommandResult = { requestId: 'r1', status: 'rejected', code: 'lane-stopped' }
const done: CommandResult = { requestId: 'r2', status: 'done', fence: 2 }

function host(...results: CommandResult[]) {
  const send = vi.fn<(op: LaneOp, laneId?: string, fence?: number) => Promise<CommandResult>>()
  for (const r of results) send.mockResolvedValueOnce(r)
  return send
}

describe('sendToLane', () => {
  // A Host restart (an update, a crash) stops every lane; nothing restarts pi.
  // Prompts were rejected `lane-stopped` until someone found the Resume button.
  it('resumes a stopped lane once, then delivers the prompt', async () => {
    const send = host(stopped, done, { requestId: 'r3', status: 'done' })
    const op: LaneOp = { type: 'prompt', message: 'hi' }
    expect(await sendToLane({ send }, op, LANE, 2)).toMatchObject({ status: 'done' })
    expect(send.mock.calls).toEqual([
      [op, LANE, 2],
      [{ type: 'lane.resume' }, LANE, 2],
      [op, LANE, 2],
    ])
  })

  it('retries at the fence the resume answered with', async () => {
    const send = host(stopped, { requestId: 'r2', status: 'done', fence: 3 }, done)
    await sendToLane({ send }, { type: 'prompt', message: 'hi' }, LANE, 2)
    expect(send.mock.calls[2]?.[2]).toBe(3)
  })

  it('returns a failed resume instead of retrying the prompt', async () => {
    const failed: CommandResult = {
      requestId: 'r2',
      status: 'failed',
      error: { code: 'internal', message: 'the lane could not start' },
    }
    const send = host(stopped, failed)
    expect(await sendToLane({ send }, { type: 'prompt', message: 'hi' }, LANE, 2)).toBe(failed)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it.each<LaneOp>([{ type: 'abort' }, { type: 'steer', message: 'x' }, { type: 'compact' }])(
    'never resumes for $type',
    async (op) => {
      const send = host(stopped)
      expect(await sendToLane({ send }, op, LANE, 2)).toBe(stopped)
      expect(send).toHaveBeenCalledTimes(1)
    },
  )

  it('passes every other prompt outcome through untouched', async () => {
    const other: CommandResult = { requestId: 'r1', status: 'rejected', code: 'not-controller' }
    const send = host(other)
    expect(await sendToLane({ send }, { type: 'prompt', message: 'hi' }, LANE, 2)).toBe(other)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('receiptResponse', () => {
  // "bee1: lane-stopped" left the user retrying a composer that could never send.
  it('tells the user to resume a stopped lane', () => {
    expect(receiptResponse('steer', stopped, 'bee1')).toMatchObject({
      success: false,
      error: 'bee1: this lane is stopped. Press Resume at the top of the lane, then send again.',
    })
  })
})
