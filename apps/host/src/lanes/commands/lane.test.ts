import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type LaneOp } from '@phosphor/shared/host-protocol'
import type { DeleteLaneOp } from '@phosphor/shared/host-protocol-repositories'
import {
  createCommandsFixture,
  deferred,
  type CommandsFixture,
} from '../__fixtures__/commands.fixture'
import type { LaneAdmission } from './admission'
import {
  deleteLane,
  deletionAllowed,
  executeLane,
  executeLifecycle,
  lifecycle,
  markRead,
  releaseControl,
  takeControl,
} from './lane'
import { queueFor } from './queue'
import { createCommandState, type Job, type LaneCommandClient } from './state'

let f: CommandsFixture
const abort = vi.fn()
beforeEach(async () => {
  vi.useFakeTimers()
  f = await createCommandsFixture()
  abort.mockReset()
  f.ports.attachments = { abort } as unknown as NonNullable<typeof f.ports.attachments>
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
function job(op: LaneOp, client: LaneCommandClient = f.one): Job {
  return {
    client,
    frame: { type: 'command', requestId: randomUUID(), laneId: f.lane.laneId, fence: 2, op },
    started: 0,
    resolve: vi.fn(),
  }
}
const admitted = (overrides: Partial<LaneAdmission> = {}): LaneAdmission => ({
  laneId: f.lane.laneId,
  lane: f.lane,
  sessionId: 'pi-live',
  piCommand: null,
  fence: 2,
  ...overrides,
})
const removal: DeleteLaneOp = {
  type: 'lane.delete',
  laneId: '',
  removeWorktree: true,
  removeBranch: false,
}
const yes = () => true

describe('control', () => {
  it('takes control: aborts uploads, publishes the new control and answers its fence', () => {
    const { state, queue } = setup()
    const current = job({ type: 'control.take' }, f.two)
    takeControl(state, f.ports, current, queue, f.lane.laneId)
    expect(abort).toHaveBeenCalledWith(f.lane.laneId)
    expect(f.events.map(({ event }) => event)).toEqual([
      { kind: 'control', control: expect.objectContaining({ fence: 2 }) },
    ])
    expect(f.last(current.frame.requestId)).toEqual({
      requestId: current.frame.requestId,
      status: 'done',
      fence: 2,
    })
  })

  it('refuses release by a non-controller with control, and releases for the controller', () => {
    const { state, queue } = setup()
    f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
    const viewer = job({ type: 'control.release' }, f.two)
    releaseControl(state, f.ports, viewer, queue, f.lane.laneId)
    expect(f.last(viewer.frame.requestId)).toMatchObject({
      status: 'rejected',
      code: 'not-controller',
      control: { fence: 2 },
    })
    expect(abort).not.toHaveBeenCalled()
    const owner = job({ type: 'control.release' })
    releaseControl(state, f.ports, owner, queue, f.lane.laneId)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(f.events.map(({ event }) => event)).toEqual([
      { kind: 'control', control: { fence: 3, controller: null } },
    ])
    expect(f.last(owner.frame.requestId)).toMatchObject({ status: 'done', fence: 3 })
  })
})

describe('markRead and the done answer', () => {
  it('advances the read mark and publishes a summary only when the projection has one', () => {
    const { state, queue } = setup()
    f.store.bumpAttention(f.lane.laneId)
    markRead(state, f.ports, queue, f.lane.laneId, 5)
    expect(f.store.getLane(f.lane.laneId)?.read).toBe(1)
    expect(f.order).toEqual(['summary'])
    f.ports.summaryFor = () => null
    markRead(state, f.ports, queue, f.lane.laneId, 5)
    expect(f.order).toEqual(['summary'])
  })

  it('answers unfenced markRead without a fence and idempotent lifecycle no-ops with one', () => {
    const { state, queue } = setup()
    const read = job({ type: 'lane.markRead', upTo: 0 })
    expect(executeLane(state, f.ports, read, queue, admitted({ fence: undefined }), yes)).toBe(
      undefined,
    )
    expect(f.last(read.frame.requestId)).toEqual({
      requestId: read.frame.requestId,
      status: 'done',
    })
    const resume = job({ type: 'lane.resume' })
    expect(executeLane(state, f.ports, resume, queue, admitted(), yes)).toBeUndefined()
    const stop = job({ type: 'lane.stop' })
    expect(
      executeLane(state, f.ports, stop, queue, admitted({ sessionId: null }), yes),
    ).toBeUndefined()
    for (const request of [resume, stop])
      expect(f.last(request.frame.requestId)).toEqual({
        requestId: request.frame.requestId,
        status: 'done',
        fence: 2,
      })
    expect(f.ports.resumeLane).not.toHaveBeenCalled()
    expect(f.ports.stopLane).not.toHaveBeenCalled()
  })

  it('answers any other op as unsupported', () => {
    const { state, queue } = setup()
    const other = job({ type: 'abort' })
    executeLane(state, f.ports, other, queue, admitted(), yes)
    expect(f.last(other.frame.requestId)).toMatchObject({ code: 'unsupported' })
  })
})

describe('deletion', () => {
  it('allows only with live capabilities, the same controller and the admitted fence', () => {
    f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
    let caps = true
    const allowed = deletionAllowed(f.ports, job(removal), admitted(), () => caps)
    expect(allowed()).toBe(true)
    caps = false
    expect(allowed()).toBe(false)
    caps = true
    expect(deletionAllowed(f.ports, job(removal, f.two), admitted(), yes)()).toBe(false)
    expect(deletionAllowed(f.ports, job(removal), admitted({ fence: 1 }), yes)()).toBe(false)
    f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
    expect(allowed()).toBe(false)
  })

  it('maps a missing port, data, refusal codes and a deadline', async () => {
    const { state, queue } = setup()
    const input = { admitted: admitted(), op: removal, allowed: yes }
    const portless = job(removal)
    expect(deleteLane(state, f.ports, portless, queue, input)).toBeUndefined()
    expect(f.last(portless.frame.requestId)).toMatchObject({ code: 'unsupported' })
    const held = deferred<{ ok: true; data: { branchKept: boolean } }>()
    f.ports.deleteLane = vi
      .fn<NonNullable<typeof f.ports.deleteLane>>()
      .mockResolvedValueOnce({ ok: true, data: { branchKept: true } })
      .mockResolvedValueOnce({ ok: false, code: 'conflict' })
      .mockImplementationOnce(() => held.promise)
    const done = job(removal)
    await deleteLane(state, f.ports, done, queue, input)?.completion
    expect(f.ports.deleteLane).toHaveBeenCalledWith(removal, expect.any(Function))
    expect(f.last(done.frame.requestId)).toEqual({
      requestId: done.frame.requestId,
      status: 'done',
      data: { branchKept: true },
    })
    const refused = job(removal)
    await deleteLane(state, f.ports, refused, queue, input)?.completion
    expect(f.last(refused.frame.requestId)).toMatchObject({ code: 'conflict' })
    const slow = job(removal)
    const running = deleteLane(state, f.ports, slow, queue, input)
    expect(running?.detached).toBe(false)
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    await running?.completion
    expect(f.last(slow.frame.requestId)).toEqual({
      requestId: slow.frame.requestId,
      status: 'unknown',
    })
  })
})

describe('lifecycle', () => {
  it('resumes a stopped lane and stops a live one, answering the admitted fence', async () => {
    const { state, queue } = setup()
    const resume = job({ type: 'lane.resume' })
    await executeLifecycle(
      state,
      f.ports,
      resume,
      queue,
      admitted({ sessionId: null }),
      'lane.resume',
    )?.completion
    expect(f.ports.resumeLane).toHaveBeenCalledWith(f.lane)
    const stop = job({ type: 'lane.stop' })
    await executeLifecycle(state, f.ports, stop, queue, admitted(), 'lane.stop')?.completion
    expect(f.ports.stopLane).toHaveBeenCalledWith(f.lane.laneId)
    for (const request of [resume, stop])
      expect(f.last(request.frame.requestId)).toMatchObject({ status: 'done', fence: 2 })
  })

  it('uses fixed failure text and logs only token-shaped error codes', async () => {
    const fail = (code: unknown) => async () => {
      throw Object.assign(new Error('private failure'), { code })
    }
    const input = { laneId: f.lane.laneId, requestId: randomUUID(), lane: f.lane }
    f.ports.stopLane = fail('first-prompt-required')
    expect(await lifecycle(f.ports, { ...input, opType: 'lane.stop' })).toEqual({
      code: 'internal',
      message: 'Send a first message before stopping this lane.',
    })
    f.ports.resumeLane = fail('first-prompt-required')
    expect(await lifecycle(f.ports, { ...input, opType: 'lane.resume' })).toEqual({
      code: 'internal',
      message: 'the lane could not start',
    })
    f.ports.stopLane = fail('bad code')
    expect(await lifecycle(f.ports, { ...input, opType: 'lane.stop' })).toMatchObject({
      message: 'the lane could not stop',
    })
    const { lane: _lane, ...identity } = input
    expect(f.logs.filter((entry) => entry.message === 'lane.command_error')).toEqual([
      {
        message: 'lane.command_error',
        data: { ...identity, op: 'lane.stop', code: 'first-prompt-required' },
      },
      {
        message: 'lane.command_error',
        data: { ...identity, op: 'lane.resume', code: 'first-prompt-required' },
      },
    ])
    expect(JSON.stringify(f.logs)).not.toMatch(/private failure|bad code/)
  })
})
