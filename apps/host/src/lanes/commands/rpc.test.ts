import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, LANE_PI_OPS, type LaneOp } from '@phosphor/shared/host-protocol'
import {
  createCommandsFixture,
  deferred,
  type CommandsFixture,
} from '../__fixtures__/commands.fixture'
import { opHash } from '../store'
import type { LaneAdmission } from './admission'
import { handled, NOT_MATCHED, type Routed } from './routing'
import { queueFor } from './queue'
import { executeRpc, toPiCommand } from './rpc'
import { createCommandState, type Job } from './state'

let f: CommandsFixture
beforeEach(async () => {
  vi.useFakeTimers()
  f = await createCommandsFixture()
})
afterEach(() => {
  f.cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const setup = () => {
  const state = createCommandState()
  return { state, queue: queueFor(state, f.lane.laneId) }
}
/** Recorded first, as submit does, so the fixture's runtime sees a pending request. */
function job(op: LaneOp): Job {
  const requestId = randomUUID()
  f.store.beginRequest(requestId, f.one.id, opHash(op), f.lane.laneId)
  return {
    client: f.one,
    frame: { type: 'command', requestId, laneId: f.lane.laneId, fence: 2, op },
    started: 0,
    resolve: vi.fn(),
  }
}
const admitted = (current: Job, overrides: Partial<LaneAdmission> = {}): LaneAdmission => ({
  laneId: f.lane.laneId,
  lane: f.lane,
  sessionId: 'pi-live',
  piCommand: toPiCommand(current.frame.op, current.frame.requestId),
  fence: 2,
  ...overrides,
})
const response = { type: 'extension_ui_response', id: 'dialog', value: 'yes' } as const
const dialog: LaneOp = { type: 'extension_ui_response', response }
function detached(routed: Routed) {
  if (!routed.handled || !routed.execution) throw new Error('expected an execution')
  expect(routed.execution.detached).toBe(true)
  return routed.execution.completion
}

describe('toPiCommand', () => {
  it('forwards exactly the protocol pi ops, under the request id', () => {
    const ops: LaneOp[] = [
      { type: 'prompt', message: 'x' },
      { type: 'steer', message: 'x' },
      { type: 'follow_up', message: 'x' },
      { type: 'abort' },
      { type: 'abort_retry' },
      { type: 'set_model', provider: 'p', modelId: 'm' },
      { type: 'set_thinking_level', level: 'off' },
      { type: 'compact' },
      { type: 'set_session_name', name: 'x' },
      { type: 'clear_queue' },
      { type: 'set_steering_mode', mode: 'all' },
      { type: 'set_follow_up_mode', mode: 'one-at-a-time' },
      { type: 'set_auto_compaction', enabled: false },
      { type: 'set_auto_retry', enabled: true },
      { type: 'bash', command: 'ls' },
      { type: 'abort_bash' },
    ]
    expect(ops.map((op) => op.type)).toEqual([...LANE_PI_OPS])
    for (const op of ops) expect(toPiCommand(op, 'id')).toEqual({ ...op, id: 'id' })
  })

  it('never forwards dialog, control, lifecycle, feature or machine ops', () => {
    const others: LaneOp[] = [
      dialog,
      { type: 'control.take' },
      { type: 'control.release' },
      { type: 'lane.stop' },
      { type: 'lane.resume' },
      { type: 'lane.markRead', upTo: 0 },
      { type: 'files.delete', path: 'a' },
      { type: 'terminal.kill', terminalId: randomUUID() },
      { type: 'routine.pauseAll' },
      { type: 'host.repositories.add', path: 'a' },
    ]
    for (const op of others) expect(toPiCommand(op, 'id')).toBeNull()
  })
})

describe('executeRpc', () => {
  it('dispatches a pi command detached and answers done with the admitted fence', async () => {
    const { state, queue } = setup()
    const current = job({ type: 'prompt', message: 'hi' })
    const completion = detached(executeRpc(state, f.ports, current, queue, admitted(current)))
    expect(f.command).toHaveBeenCalledWith('pi-live', {
      type: 'prompt',
      message: 'hi',
      id: current.frame.requestId,
    })
    f.finish(0)
    await completion
    expect(f.store.getReceipt(current.frame.requestId, f.one.id)).toEqual({
      requestId: current.frame.requestId,
      status: 'done',
      fence: 2,
    })
  })

  it('maps pi errors to sanitized pi-error failures and transport loss to unknown', async () => {
    const { state, queue } = setup()
    const failed = job({ type: 'compact' })
    const failing = detached(executeRpc(state, f.ports, failed, queue, admitted(failed)))
    f.finish(0, { type: 'response', command: 'compact', success: false, error: ' bad\nnews ' })
    await failing
    expect(f.last(failed.frame.requestId)).toEqual({
      requestId: failed.frame.requestId,
      status: 'failed',
      error: { code: 'pi-error', message: 'bad news' },
    })
    const lost = job({ type: 'abort' })
    const losing = detached(executeRpc(state, f.ports, lost, queue, admitted(lost)))
    f.pending[1]?.reject(new Error('private'))
    await losing
    expect(f.last(lost.frame.requestId)).toEqual({
      requestId: lost.frame.requestId,
      status: 'unknown',
    })
    expect(f.logs.at(-1)).toMatchObject({ data: { reason: 'transport' } })
  })

  it('answers a dialog detached, publishing its resolution only after pi accepted it', async () => {
    const { state, queue } = setup()
    const accepted = deferred<void>()
    f.respond.mockImplementationOnce(() => accepted.promise)
    const current = job(dialog)
    const completion = detached(executeRpc(state, f.ports, current, queue, admitted(current)))
    expect(f.respond).toHaveBeenCalledWith('pi-live', response)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.events).toEqual([])
    accepted.release()
    await completion
    expect(f.events.map(({ event }) => event)).toEqual([
      { kind: 'dialog-resolved', dialogId: 'dialog' },
    ])
    expect(f.last(current.frame.requestId)).toEqual({
      requestId: current.frame.requestId,
      status: 'done',
      fence: 2,
    })
  })

  it('does not resolve a dialog pi did not answer, and refuses one on a stopped lane', async () => {
    const { state, queue } = setup()
    f.respond.mockImplementationOnce(() => new Promise(() => {}))
    const slow = job(dialog)
    const completion = detached(executeRpc(state, f.ports, slow, queue, admitted(slow)))
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    await completion
    expect(f.last(slow.frame.requestId)).toEqual({
      requestId: slow.frame.requestId,
      status: 'unknown',
    })
    expect(f.events).toEqual([])
    const stopped = job(dialog)
    expect(
      executeRpc(state, f.ports, stopped, queue, admitted(stopped, { sessionId: null })),
    ).toEqual(handled())
    expect(f.last(stopped.frame.requestId)).toMatchObject({ code: 'lane-stopped' })
  })

  it('leaves ops that are neither pi commands nor dialog answers unmatched', () => {
    const { state, queue } = setup()
    for (const op of [{ type: 'control.take' }, { type: 'lane.stop' }] satisfies LaneOp[]) {
      const current = job(op)
      expect(executeRpc(state, f.ports, current, queue, admitted(current))).toEqual(NOT_MATCHED)
    }
    expect(f.command).not.toHaveBeenCalled()
    expect(f.respond).not.toHaveBeenCalled()
  })
})
