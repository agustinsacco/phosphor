import { describe, expect, it, vi } from 'vitest'
import type { LaneOp } from '@phosphor/shared/host-protocol'
import type { CommandResult } from './connection'
import { BASH_UNCONFIRMED } from '@phosphor/shared/remote-host'
import {
  laneCreateOp,
  laneOperation,
  receiptResponse,
  sendToLane,
  startedPrompt,
  UNKNOWN_OUTCOME,
} from './lane-ops'

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
  // A `!command` that outlives the Host's deadline is not a failure: it may still run.
  it('reports an unconfirmed shell command as possibly still running, not failed', () => {
    const unknown: CommandResult = { requestId: 'r', status: 'unknown' } as CommandResult
    expect(receiptResponse('bash', unknown, 'bee1')).toMatchObject({
      success: false,
      error: `bee1: ${BASH_UNCONFIRMED}`,
    })
    expect(receiptResponse('prompt', unknown, 'bee1')).toMatchObject({ error: UNKNOWN_OUTCOME })
  })

  // "bee1: lane-stopped" left the user retrying a composer that could never send.
  it('tells the user to resume a stopped lane', () => {
    expect(receiptResponse('steer', stopped, 'bee1')).toMatchObject({
      success: false,
      error: 'bee1: this lane is stopped. Press Resume at the top of the lane, then send again.',
    })
  })
})

describe('laneOperation', () => {
  it('forwards the session options, queue clear and shell commands a Host accepts', () => {
    for (const command of [
      { type: 'clear_queue' },
      { type: 'set_steering_mode', mode: 'all' },
      { type: 'set_follow_up_mode', mode: 'one-at-a-time' },
      { type: 'set_auto_compaction', enabled: false },
      { type: 'set_auto_retry', enabled: true },
      { type: 'bash', command: 'ls', excludeFromContext: true },
      { type: 'abort_bash' },
    ] as const)
      expect(laneOperation({ ...command, id: 'x' })).toEqual(command)
  })

  it('still refuses commands that move pi to another session file', () => {
    for (const type of ['fork', 'clone', 'new_session'] as const)
      expect(laneOperation({ type } as never)).toBeNull()
  })

  it('tells the user to update an older Host that refuses an op as unsupported', () => {
    expect(
      receiptResponse('bash', { requestId: 'r', status: 'rejected', code: 'unsupported' }, 'bee1'),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('Updating the Host may help'),
    })
  })
})

describe('lane.create with a first prompt', () => {
  const input = { repositoryId: 'repo', prompt: 'Fix it', model: 'm' }
  it('sends the prompt only to a Host that takes it', () => {
    expect(laneCreateOp(input, true)).toEqual({
      type: 'lane.create',
      repositoryId: 'repo',
      model: 'm',
      worktree: null,
      prompt: 'Fix it',
    })
    expect(laneCreateOp(input, false)).toEqual({
      type: 'lane.create',
      repositoryId: 'repo',
      model: 'm',
      worktree: null,
    })
  })
  it('reads the Host answer, and says so when it gave none', () => {
    const op = laneCreateOp(input, true)
    const done = (data?: unknown): CommandResult => ({
      requestId: 'r',
      status: 'done',
      laneId: 'lane',
      ...(data === undefined ? {} : { data }),
    })
    expect(startedPrompt(op, done({ prompted: true }))).toBe(true)
    expect(startedPrompt(op, done({ prompted: false }))).toBe(false)
    expect(startedPrompt(op, done())).toBeUndefined()
    expect(startedPrompt(op, done({ prompted: 'yes' }))).toBeUndefined()
    expect(startedPrompt(laneCreateOp(input, false), done())).toBe(false)
  })
})
