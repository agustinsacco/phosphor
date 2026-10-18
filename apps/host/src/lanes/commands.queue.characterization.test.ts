import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type LaneOp } from '@phosphor/shared/host-protocol'
import * as folders from './worktree'
import {
  COMMAND_CLOSE_GRACE_MS,
  createLaneCommands,
  type LaneCommandClient,
  type LaneCommandFrame,
} from './commands'
import {
  createCommandsFixture,
  deferred,
  type CommandsFixture,
} from './__fixtures__/commands.fixture'

// Characterizes queue slots, deadlines, close and failure handling through
// createLaneCommands before HA-08 moves that state out of the factory.

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

const machine = (op: LaneOp): LaneCommandFrame => ({
  type: 'command',
  requestId: randomUUID(),
  op,
})
const late = () => f.logs.filter((entry) => entry.message === 'lane.command_late')
const commandLogs = () =>
  f.logs.filter((entry) => entry.message === 'lane.command').map((entry) => entry.data)

describe('answer deadlines keep the operation slot until it settles', () => {
  it('keeps a timed-out lifecycle slot, runs the next job, and frees one slot on late settlement', async () => {
    f.service = createLaneCommands(f.ports, { queueLimit: 2 })
    const stopped = deferred<void>()
    f.ports.stopLane = vi.fn(() => stopped.promise)
    const stop = f.frame({ type: 'lane.stop' })
    const stopping = f.service.submit(f.one, stop)
    const next = f.frame({ type: 'abort' }, 2)
    const queued = f.service.submit(f.one, next)
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs - 1)
    expect(f.last(stop.requestId)).toBeUndefined()
    expect(f.command).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(f.last(stop.requestId)).toEqual({ requestId: stop.requestId, status: 'unknown' })
    expect(commandLogs()).toContainEqual(
      expect.objectContaining({ requestId: stop.requestId, status: 'unknown', reason: 'deadline' }),
    )
    expect(f.command).toHaveBeenCalledTimes(1)
    const busy = f.frame({ type: 'abort' }, 2)
    await f.service.submit(f.one, busy)
    expect(f.last(busy.requestId)).toMatchObject({ status: 'rejected', code: 'busy' })
    expect(f.store.getReceipt(busy.requestId, f.one.id)).toBeNull()
    stopped.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(late()).toEqual([
      {
        message: 'lane.command_late',
        data: { laneId: f.lane.laneId, requestId: stop.requestId, op: 'lane.stop' },
      },
    ])
    expect(f.receipts(stop.requestId)).toHaveLength(1)
    expect(f.store.getReceipt(stop.requestId, f.one.id)?.status).toBe('unknown')
    const retry = f.service.submit(f.one, busy)
    expect(f.command).toHaveBeenCalledTimes(2)
    const full = f.frame({ type: 'abort' }, 2)
    await f.service.submit(f.one, full)
    expect(f.last(full.requestId)).toMatchObject({ code: 'busy' })
    f.finish(0)
    f.finish(1)
    await Promise.all([queued, retry])
    expect(f.last(next.requestId)?.status).toBe('done')
    expect(f.last(busy.requestId)?.status).toBe('done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts a timed-out machine operation against the machine queue until a late rejection', async () => {
    f.service = createLaneCommands(f.ports, { queueLimit: 1 })
    const held = deferred<{ ok: true }>()
    const execute = vi.fn(() => held.promise)
    f.ports.repositories = { execute }
    const client: LaneCommandClient = { ...f.one, caps: ['workspaces.write', 'sessions.control'] }
    const first = machine({ type: 'host.repositories.add', path: 'one' })
    const running = f.service.submit(client, first)
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    await running
    expect(f.last(first.requestId)).toEqual({ requestId: first.requestId, status: 'unknown' })
    const second = machine({ type: 'host.repositories.add', path: 'two' })
    await f.service.submit(client, second)
    expect(f.last(second.requestId)).toMatchObject({ status: 'rejected', code: 'busy' })
    // A resend of a recorded request is admitted even when the queue is full.
    await f.service.submit(client, first)
    expect(f.receipts(first.requestId)).toHaveLength(2)
    held.reject(new Error('private failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(late()).toEqual([
      {
        message: 'lane.command_late',
        data: { laneId: '', requestId: first.requestId, op: 'host.repositories.add' },
      },
    ])
    execute.mockResolvedValueOnce({ ok: true })
    await f.service.submit(client, second)
    expect(f.last(second.requestId)).toEqual({ requestId: second.requestId, status: 'done' })
    expect(JSON.stringify(f.logs)).not.toContain('private failure')
  })
})

describe('close settles once', () => {
  it('resolves without work, is idempotent, and then refuses submissions and status silently', async () => {
    const close = f.service.close()
    expect(f.service.close()).toBe(close)
    await close
    expect(vi.getTimerCount()).toBe(0)
    const request = f.frame()
    await f.service.submit(f.one, request)
    f.service.status(f.one.id, request.requestId)
    expect(f.sent).toEqual([])
    expect(f.store.getReceipt(request.requestId, f.one.id)).toBeNull()
    expect(f.command).not.toHaveBeenCalled()
    expect(f.service.close()).toBe(close)
  })

  it('resolves queued jobs at once without running them, and lets work that settles in the grace answer', async () => {
    const stopped = deferred<void>()
    f.ports.stopLane = vi.fn(() => stopped.promise)
    const stop = f.frame({ type: 'lane.stop' })
    const stopping = f.service.submit(f.one, stop)
    const queued = f.frame({ type: 'abort' }, 2)
    let resolved = false
    const waiting = f.service.submit(f.one, queued).then(() => {
      resolved = true
    })
    let closed = false
    const close = f.service.close().then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(closed).toBe(false)
    stopped.release()
    await Promise.all([stopping, waiting, close])
    expect(closed).toBe(true)
    expect(f.last(stop.requestId)).toEqual({ requestId: stop.requestId, status: 'done', fence: 2 })
    expect(f.store.getReceipt(queued.requestId, f.one.id)?.status).toBe('pending')
    expect(f.receipts(queued.requestId)).toEqual([])
    expect(f.command).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops waiting at the grace bound and ignores receipts, logs and publications after it', async () => {
    const request = f.frame()
    const running = f.service.submit(f.one, request)
    let closed = false
    const close = f.service.close().then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(COMMAND_CLOSE_GRACE_MS - 1)
    expect(closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await close
    const finish = vi.spyOn(f.store, 'finishRequest')
    const publish = vi.spyOn(f.ports, 'publish')
    const logs = f.logs.length
    const sent = f.sent.length
    f.finish(0)
    await running
    expect(finish).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(f.logs).toHaveLength(logs)
    expect(f.sent).toHaveLength(sent)
    expect(f.store.getReceipt(request.requestId, f.one.id)?.status).toBe('pending')
  })
})

describe('delivery, logging and store failures never strand the queue', () => {
  it('runs lifecycle, control, read and pi jobs in order with every side channel throwing', async () => {
    f.ports.deliver = () => {
      throw new Error('disconnected')
    }
    f.ports.log = () => {
      throw new Error('logger unavailable')
    }
    vi.spyOn(f.store, 'finishRequest').mockImplementation(() => {
      throw new Error('storage failed')
    })
    const stopped = deferred<void>()
    f.ports.stopLane = vi.fn(() => stopped.promise)
    const order: string[] = []
    const track = (name: string, run: Promise<void>) => run.then(() => order.push(name))
    const jobs = [
      track('stop', f.service.submit(f.one, f.frame({ type: 'lane.stop' }))),
      track('take', f.service.submit(f.two, f.frame({ type: 'control.take' }))),
      track('read', f.service.submit(f.one, f.frame({ type: 'lane.markRead', upTo: 0 }))),
      track('prompt', f.service.submit(f.two, f.frame(undefined, 3))),
    ]
    expect(order).toEqual([])
    stopped.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['stop', 'take', 'read'])
    expect(f.command).toHaveBeenCalledTimes(1)
    f.finish(0)
    await Promise.all(jobs)
    expect(order).toEqual(['stop', 'take', 'read', 'prompt'])
    expect(f.store.getLane(f.lane.laneId)?.control).toMatchObject({
      fence: 3,
      controller: { clientId: f.two.id },
    })
  })

  it('answers unknown for a job whose execution throws, then runs the next one', async () => {
    f.ports.summaryFor = () => {
      throw new Error('private projection')
    }
    f.command.mockImplementationOnce(() => {
      throw new Error('private transport')
    })
    const read = f.frame({ type: 'lane.markRead', upTo: 0 })
    const thrown = f.frame(undefined, 2)
    const next = f.frame({ type: 'abort' }, 2)
    await f.service.submit(f.one, f.frame({ type: 'control.take' }))
    const runs = [read, thrown, next].map((request) => f.service.submit(f.one, request))
    expect(f.command).toHaveBeenCalledTimes(2)
    f.finish(0)
    await Promise.all(runs)
    expect(f.last(read.requestId)).toEqual({ requestId: read.requestId, status: 'unknown' })
    expect(f.last(thrown.requestId)).toEqual({ requestId: thrown.requestId, status: 'unknown' })
    expect(f.last(next.requestId)).toMatchObject({ status: 'done', fence: 2 })
    expect(commandLogs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: read.requestId, reason: 'host' }),
        expect.objectContaining({ requestId: thrown.requestId, reason: 'transport' }),
      ]),
    )
    expect(JSON.stringify(f.logs)).not.toMatch(/private/)
  })

  it('keeps created-lane holds ordered when delivery and logging throw', async () => {
    vi.spyOn(folders, 'prepareLaneFolder').mockResolvedValue({
      cwd: f.lane.cwd,
      branch: null,
      undo: async () => {},
    })
    const gate = deferred<void>()
    const entered = deferred<string>()
    vi.mocked(f.ports.sessions.attach).mockImplementation(async (laneId, sessionId) => {
      entered.release(laneId)
      await gate.promise
      f.sessions.set(laneId, sessionId)
    })
    f.ports.deliver = () => {
      throw new Error('disconnected')
    }
    f.ports.log = () => {
      throw new Error('logger unavailable')
    }
    const create = machine({
      type: 'lane.create',
      repositoryId: f.lane.repositoryId,
      worktree: null,
    })
    const creating = f.service.submit(f.one, create)
    const laneId = await entered.promise
    const take = f.frame({ type: 'control.take' }, 1, laneId)
    const read = f.frame({ type: 'lane.markRead', upTo: 0 }, 1, laneId)
    const prompt = f.frame(undefined, 2, laneId)
    const queued = [take, read, prompt].map((request) => f.service.submit(f.two, request))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.events).toEqual([])
    expect(f.command).not.toHaveBeenCalled()
    gate.release()
    await creating
    await vi.advanceTimersByTimeAsync(0)
    expect(f.events.map(({ event }) => event.kind)).toEqual([
      'control',
      'summary',
      'control',
      'summary',
    ])
    expect(f.command).toHaveBeenCalledWith(
      'new-session',
      expect.objectContaining({ id: prompt.requestId }),
    )
    f.finish(0)
    await Promise.all(queued)
    expect(f.store.getReceipt(create.requestId, f.one.id)).toEqual({
      requestId: create.requestId,
      status: 'done',
      laneId,
      fence: 1,
    })
    expect(f.store.getReceipt(take.requestId, f.two.id)).toMatchObject({ status: 'done', fence: 2 })
    expect(f.store.getReceipt(prompt.requestId, f.two.id)).toMatchObject({
      status: 'done',
      fence: 2,
    })
  })
})
