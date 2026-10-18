import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type LaneOp, type Receipt } from '@phosphor/shared/host-protocol'
import type { RequestStart } from '../store'
import {
  answer,
  cleanup,
  close,
  dispatch,
  drain,
  publish,
  queueFor,
  status,
  submit,
  type QueuePorts,
} from './queue'
import {
  COMMAND_CLOSE_GRACE_MS,
  createCommandState,
  LANE_QUEUE_LIMIT,
  type CommandRouter,
  type Execution,
  type Job,
  type LaneCommandClient,
  type LaneCommandFrame,
  type LaneCommandPorts,
  type LaneQueue,
} from './state'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function deferred<T>() {
  let release: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, fail) => {
    release = resolve
    reject = fail
  })
  return { promise, release, reject }
}
function ports() {
  return {
    store: {
      finishRequest: vi.fn<(requestId: string, receipt: Receipt) => void>(),
      getReceipt: vi.fn<(requestId: string, clientId: string) => Receipt | null>(() => null),
      beginRequest: vi.fn<(...args: [string, string, string, string | null]) => RequestStart>(
        () => ({ kind: 'new' }),
      ),
    },
    deliver: vi.fn<QueuePorts['deliver']>(),
    publish: vi.fn<LaneCommandPorts['publish']>(),
    log: vi.fn<QueuePorts['log']>(),
    now: vi.fn(() => 0),
  } satisfies QueuePorts & Pick<LaneCommandPorts, 'publish'>
}
const client: LaneCommandClient = { id: randomUUID(), label: 'One', caps: ['sessions.control'] }
const laneId = randomUUID()
function frame(
  op: LaneOp = { type: 'abort' },
  lane: string | undefined = laneId,
): LaneCommandFrame {
  return { type: 'command', requestId: randomUUID(), laneId: lane, fence: 1, op }
}
function job(request = frame()): Job {
  return { client, frame: request, started: 0, resolve: vi.fn() }
}
const statuses = (p: ReturnType<typeof ports>) =>
  p.deliver.mock.calls.map(([, receipt]) => receipt.status)

describe('state and queue bookkeeping', () => {
  it('validates the limit and starts open and empty', () => {
    expect(createCommandState()).toMatchObject({ limit: LANE_QUEUE_LIMIT, closing: false })
    for (const limit of [0, -1, 1.5, LANE_QUEUE_LIMIT + 1])
      expect(() => createCommandState(limit)).toThrow('invalid lane queue limit')
    const state = createCommandState(3)
    expect(state.queues.size).toBe(0)
    expect(state.work.size).toBe(0)
    expect(state.closed).toBe(false)
    expect(state.closePromise).toBeUndefined()
  })

  it('reuses one queue per key and forgets it only when nothing keeps it', () => {
    const state = createCommandState()
    const queue = queueFor(state, 'lane')
    expect(queueFor(state, 'lane')).toBe(queue)
    for (const keep of [
      'draining',
      'jobs',
      'outstanding',
      'holds',
      'controlUnpublished',
    ] as const) {
      const held: LaneQueue = { ...queue }
      if (keep === 'jobs') held.jobs = [job()]
      else if (keep === 'outstanding' || keep === 'holds') held[keep] = 1
      else held[keep] = true
      state.queues.set('lane', held)
      cleanup(state, 'lane', held)
      expect(state.queues.get('lane'), keep).toBe(held)
    }
    cleanup(state, 'lane', queue)
    expect(state.queues.has('lane')).toBe(false)
    const closed = createCommandState()
    const kept = queueFor(closed, 'lane')
    closed.closed = true
    cleanup(closed, 'lane', kept)
    expect(closed.queues.get('lane')).toBe(kept)
  })

  it('marks control owed when its publication fails and clears it on the next success', () => {
    const state = createCommandState()
    const p = ports()
    const queue = queueFor(state, laneId)
    const control = { kind: 'control' as const, control: { fence: 2, controller: null } }
    p.publish.mockImplementationOnce(() => {
      throw new Error('stream failed')
    })
    expect(publish(state, p, laneId, control, queue)).toBe(false)
    expect(queue.controlUnpublished).toBe(true)
    expect(p.log).toHaveBeenCalledWith('host', 'lane.publish_failed', { laneId, kind: 'control' })
    expect(publish(state, p, laneId, { kind: 'dialog-resolved', dialogId: 'd' }, queue)).toBe(true)
    expect(queue.controlUnpublished).toBe(true)
    expect(publish(state, p, laneId, control, queue)).toBe(true)
    expect(queue.controlUnpublished).toBe(false)
    state.closed = true
    expect(publish(state, p, laneId, control, queue)).toBe(false)
    expect(p.publish).toHaveBeenCalledTimes(3)
  })
})

describe('answer and dispatch', () => {
  it('holds the slot past the deadline and logs only identity when the late answer lands', async () => {
    const state = createCommandState()
    const p = ports()
    const queue = queueFor(state, laneId)
    const late = deferred<string>()
    const replied = answer(
      state,
      p,
      { laneId, requestId: 'r', opType: 'abort' },
      queue,
      late.promise,
    )
    expect(queue.outstanding).toBe(1)
    expect(state.work.has(late.promise)).toBe(true)
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    expect(await replied).toEqual({ answered: false, reason: 'deadline' })
    expect(queue.outstanding).toBe(1)
    expect(state.queues.get(laneId)).toBe(queue)
    late.release('private payload')
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.outstanding).toBe(0)
    expect(p.log.mock.calls).toEqual([
      ['host', 'lane.command_late', { laneId, requestId: 'r', op: 'abort' }],
    ])
    expect(state.queues.has(laneId)).toBe(false)
    expect(state.work.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answers values, maps rejections and synchronous throws to transport, and clears its timer', async () => {
    const state = createCommandState()
    const p = ports()
    const queue = queueFor(state, laneId)
    expect(await dispatch(state, p, job(), queue, () => 'value')).toEqual({
      answered: true,
      value: 'value',
    })
    expect(await dispatch(state, p, job(), queue, () => Promise.reject(new Error('x')))).toEqual({
      answered: false,
      reason: 'transport',
    })
    const thrown = dispatch(state, p, job(), queue, () => {
      throw new Error('sync')
    })
    expect(await thrown).toEqual({ answered: false, reason: 'transport' })
    expect(queue.outstanding).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(p.log).not.toHaveBeenCalled()
  })

  it('identifies machine-queue work by the empty lane key', async () => {
    const state = createCommandState()
    const p = ports()
    const queue = queueFor(state, '')
    const late = deferred<void>()
    const machineJob = job({
      type: 'command',
      requestId: randomUUID(),
      op: { type: 'routine.pauseAll' },
    })
    void dispatch(state, p, machineJob, queue, () => late.promise)
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    late.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(p.log).toHaveBeenCalledWith('host', 'lane.command_late', {
      laneId: '',
      requestId: machineJob.frame.requestId,
      op: 'routine.pauseAll',
    })
    expect(state.queues.has('')).toBe(false)
  })
})

/** A router whose executions the test completes by hand. */
function router(executions: (Execution | void | 'throw')[] = []) {
  const ran: string[] = []
  const execute = vi.fn((current: Job, _queue: LaneQueue): Execution | void => {
    ran.push(current.frame.requestId)
    const next = executions.shift()
    if (next === 'throw') throw new Error('private failure')
    return next
  })
  const routed: CommandRouter = { capabilityFor: () => ['sessions.control'], execute }
  return { routed, execute, ran }
}

describe('drain', () => {
  it('runs jobs in order, holds for attached work and releases detached work at dispatch', async () => {
    const state = createCommandState()
    const p = ports()
    const queue = queueFor(state, laneId)
    const attached = deferred<void>()
    const detached = deferred<void>()
    const r = router([
      { completion: attached.promise, detached: false },
      { completion: detached.promise, detached: true },
      undefined,
    ])
    const jobs = [job(), job(), job()]
    queue.jobs.push(...jobs)
    const draining = drain(state, p, r.routed.execute, laneId, queue)
    expect(queue.draining).toBe(true)
    expect(r.ran).toEqual([jobs[0]?.frame.requestId])
    attached.release()
    await draining
    expect(r.ran).toEqual(jobs.map((entry) => entry.frame.requestId))
    expect(jobs.map((entry) => vi.mocked(entry.resolve).mock.calls.length)).toEqual([1, 0, 1])
    expect(queue.draining).toBe(false)
    expect(state.work.size).toBe(1)
    detached.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(jobs[1]?.resolve).toHaveBeenCalledTimes(1)
    expect(state.work.size).toBe(0)
    expect(state.queues.has(laneId)).toBe(false)
  })

  it('answers unknown for a throwing execution or completion and keeps draining', async () => {
    const state = createCommandState()
    const p = ports()
    const queue = queueFor(state, laneId)
    const r = router(['throw', { completion: Promise.reject(new Error('x')), detached: false }])
    const jobs = [job(), job(), job()]
    queue.jobs.push(...jobs)
    await drain(state, p, r.routed.execute, laneId, queue)
    expect(r.ran).toHaveLength(3)
    expect(p.store.finishRequest.mock.calls.map(([, receipt]) => receipt.status)).toEqual([
      'unknown',
      'unknown',
    ])
    expect(p.log.mock.calls.map(([, , data]) => data)).toEqual([
      expect.objectContaining({ status: 'unknown', reason: 'host' }),
      expect.objectContaining({ status: 'unknown', reason: 'host' }),
    ])
    expect(jobs.every((entry) => vi.mocked(entry.resolve).mock.calls.length === 1)).toBe(true)
    expect(JSON.stringify(p.log.mock.calls)).not.toContain('private failure')
  })

  it('stops at a hold or once closing, leaving later jobs queued', async () => {
    const state = createCommandState()
    const p = ports()
    const queue = queueFor(state, laneId)
    const r = router()
    queue.jobs.push(job(), job())
    queue.holds = 1
    await drain(state, p, r.routed.execute, laneId, queue)
    expect(r.execute).not.toHaveBeenCalled()
    expect(state.queues.get(laneId)).toBe(queue)
    queue.holds = 0
    state.closing = true
    await drain(state, p, r.routed.execute, laneId, queue)
    expect(r.execute).not.toHaveBeenCalled()
    expect(queue.jobs).toHaveLength(2)
  })
})

describe('submit and status', () => {
  it('refuses missing capabilities and full queues unrecorded on the attempt connection', async () => {
    const state = createCommandState(1)
    const p = ports()
    const r = router()
    const attempt = { ...client, connectionId: 'conn' }
    await submit(state, p, r.routed, { ...attempt, caps: [] }, frame())
    expect(p.deliver).toHaveBeenLastCalledWith(
      client.id,
      expect.objectContaining({ code: 'forbidden' }),
      'conn',
    )
    // A late, timed-out operation still occupies the only slot.
    queueFor(state, laneId).outstanding = 1
    const full = frame()
    await submit(state, p, r.routed, attempt, full)
    expect(p.deliver).toHaveBeenLastCalledWith(
      client.id,
      expect.objectContaining({ requestId: full.requestId, code: 'busy' }),
      'conn',
    )
    expect(p.store.beginRequest).not.toHaveBeenCalled()
    // A recorded resend is admitted when full, and answered from the store.
    p.store.getReceipt.mockReturnValueOnce({ requestId: full.requestId, status: 'pending' })
    p.store.beginRequest.mockReturnValueOnce({
      kind: 'existing',
      receipt: { requestId: full.requestId, status: 'pending' },
    })
    await submit(state, p, r.routed, attempt, full)
    expect(p.deliver).toHaveBeenLastCalledWith(
      client.id,
      { requestId: full.requestId, status: 'pending' },
      'conn',
    )
    expect(p.store.finishRequest).not.toHaveBeenCalled()
    expect(r.execute).not.toHaveBeenCalled()
  })

  it('records, enqueues and drains a new request, resolving when its job completes', async () => {
    const state = createCommandState()
    const p = ports()
    const done = deferred<void>()
    const r = router([{ completion: done.promise, detached: false }])
    const request = frame()
    let resolved = false
    const running = submit(state, p, r.routed, client, request).then(() => (resolved = true))
    expect(p.store.beginRequest).toHaveBeenCalledWith(
      request.requestId,
      client.id,
      expect.stringMatching(/^[0-9a-f]{64}$/),
      laneId,
    )
    expect(r.ran).toEqual([request.requestId])
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(false)
    done.release()
    await running
    expect(resolved).toBe(true)
    // The drain loop forgets the idle queue just after the job's submission resolves.
    expect(state.queues.get(laneId)?.draining).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.queues.has(laneId)).toBe(false)
  })

  it('maps store conflicts and busy starts to unrecorded refusals', async () => {
    const state = createCommandState()
    const p = ports()
    const r = router()
    for (const kind of ['conflict', 'busy'] as const) {
      p.store.beginRequest.mockReturnValueOnce({ kind })
      await submit(state, p, r.routed, client, frame())
      expect(p.deliver.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'rejected', code: kind })
    }
    expect(p.store.finishRequest).not.toHaveBeenCalled()
    expect(r.execute).not.toHaveBeenCalled()
  })

  it('queues behind a hold and does nothing once closing', async () => {
    const state = createCommandState()
    const p = ports()
    const r = router()
    queueFor(state, laneId).holds = 1
    let resolved = false
    void submit(state, p, r.routed, client, frame()).then(() => (resolved = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(r.execute).not.toHaveBeenCalled()
    expect(state.queues.get(laneId)?.jobs).toHaveLength(1)
    void close(state)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true)
    await submit(state, p, r.routed, client, frame())
    status(state, p, client.id, randomUUID())
    expect(p.deliver).not.toHaveBeenCalled()
    expect(p.store.beginRequest).toHaveBeenCalledTimes(1)
  })

  it('answers status from the store, or unknown, to the asking connection', () => {
    const state = createCommandState()
    const p = ports()
    const requestId = randomUUID()
    status(state, p, client.id, requestId, 'conn')
    expect(p.deliver).toHaveBeenLastCalledWith(client.id, { requestId, status: 'unknown' }, 'conn')
    p.store.getReceipt.mockReturnValueOnce({ requestId, status: 'done' })
    status(state, p, client.id, requestId)
    expect(p.deliver).toHaveBeenLastCalledWith(client.id, { requestId, status: 'done' }, undefined)
    expect(statuses(p)).toEqual(['unknown', 'done'])
  })
})

describe('close', () => {
  it('is idempotent, waits at most the grace for work, then clears queues', async () => {
    const state = createCommandState()
    const queue = queueFor(state, laneId)
    const waiting = job()
    queue.jobs.push(waiting)
    const forever = new Promise<void>(() => {})
    state.work.add(forever)
    const closing = close(state)
    expect(close(state)).toBe(closing)
    expect(state.closing).toBe(true)
    expect(waiting.resolve).toHaveBeenCalledTimes(1)
    expect(queue.jobs).toEqual([])
    await vi.advanceTimersByTimeAsync(COMMAND_CLOSE_GRACE_MS - 1)
    expect(state.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await closing
    expect(state.closed).toBe(true)
    expect(state.queues.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles as soon as tracked work settles', async () => {
    const state = createCommandState()
    const work = deferred<void>()
    state.work.add(work.promise)
    let closed = false
    const closing = close(state).then(() => (closed = true))
    await vi.advanceTimersByTimeAsync(10)
    expect(closed).toBe(false)
    work.reject(new Error('settled anyway'))
    await closing
    expect(closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
