// HA-01 baseline inventory: 91 discovered command cases; all pass before partitioning.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { openStore, opHash } from './store'
import { createLaneCommands, LANE_QUEUE_LIMIT } from './commands'
import {
  createCommandsFixture,
  deferred,
  type CommandsFixture,
} from './__fixtures__/commands.fixture'

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

describe('lane commands R7 ordering', () => {
  it('acquires once, publishes before run, rejects stale contenders and current-fence viewers', async () => {
    const first = f.frame()
    const second = f.frame()
    const a = f.service.submit(f.one, first)
    const b = f.service.submit(f.two, second)
    expect(f.order).toEqual(['control', 'run'])
    expect(f.store.getReceipt(first.requestId, f.one.id)?.status).toBe('pending')
    expect(f.command).toHaveBeenCalledTimes(1)
    expect(f.last(second.requestId)).toMatchObject({ code: 'stale-fence' })
    f.finish(0)
    await a
    expect(f.command).toHaveBeenCalledTimes(1)
    await b
    expect(f.last(second.requestId)).toMatchObject({
      status: 'rejected',
      code: 'stale-fence',
      control: { fence: 2, controller: { clientId: f.one.id } },
    })
    const retry = f.frame({ type: 'abort' }, 2)
    await f.service.submit(f.two, retry)
    expect(f.last(retry.requestId)).toMatchObject({
      code: 'not-controller',
      control: { controller: { clientId: f.one.id } },
    })
    expect(f.command).toHaveBeenCalledTimes(1)
  })

  it('admits takeover while a prompt is in flight, then rejects the old controller', async () => {
    const prompt = f.frame()
    const original = f.service.submit(f.one, prompt)
    const take = f.frame({ type: 'control.take' })
    const takeover = f.service.submit(f.two, take)
    const stale = f.frame({ type: 'abort' }, 2)
    const old = f.service.submit(f.one, stale)
    const next = f.service.submit(f.two, f.frame({ type: 'abort' }, 3))
    await takeover
    await old
    expect(f.pending).toHaveLength(2)
    expect(f.command).toHaveBeenCalledTimes(2)
    f.finish(0)
    await original
    expect(f.last(prompt.requestId)).toMatchObject({ status: 'done', fence: 2 })
    expect(f.last(take.requestId)).toMatchObject({ status: 'done', fence: 3 })
    expect(f.last(stale.requestId)).toMatchObject({ code: 'stale-fence' })
    expect(f.order).toEqual(['control', 'run', 'control', 'run'])
    f.finish(1)
    await next
  })

  it('runs duplicate ids once, gives pending then the same terminal, and refuses op/client conflicts', async () => {
    const request = f.frame()
    const running = f.service.submit(f.one, request)
    await f.service.submit(f.one, request)
    expect(f.last(request.requestId)).toMatchObject({ status: 'pending' })
    f.service.status(f.one.id, request.requestId)
    expect(f.last(request.requestId)).toMatchObject({ status: 'pending' })
    f.finish(0)
    await running
    const terminal = f.last(request.requestId)
    await f.service.submit(f.one, request)
    expect(f.last(request.requestId)).toEqual(terminal)
    expect(f.command).toHaveBeenCalledTimes(1)
    await f.service.submit(f.one, { ...request, op: { type: 'abort' } })
    expect(f.last(request.requestId)).toMatchObject({ code: 'conflict' })
    await f.service.submit(f.two, request)
    expect(f.sent.at(-1)).toMatchObject({ clientId: f.two.id, receipt: { code: 'conflict' } })
    f.service.status(f.two.id, request.requestId)
    expect(f.sent.at(-1)).toEqual({
      clientId: f.two.id,
      receipt: { requestId: request.requestId, status: 'unknown' },
    })
    f.service.status(f.one.id, randomUUID())
    expect(f.sent.at(-1)?.receipt.status).toBe('unknown')
  })

  it('conflicts on another client request id without exposing the pending receipt', async () => {
    const request = f.frame()
    const running = f.service.submit(f.one, request)
    const collision = f.service.submit(f.two, request)
    expect(f.sent.at(-1)).toMatchObject({ clientId: f.two.id, receipt: { code: 'conflict' } })
    await collision
    f.service.status(f.two.id, request.requestId)
    expect(f.last(request.requestId)?.status).toBe('unknown')
    expect(f.command).toHaveBeenCalledTimes(1)
    f.finish(0)
    await running
  })

  it('reopens an interrupted request as unknown and never replays it', async () => {
    const request = f.frame()
    f.store.beginRequest(request.requestId, f.one.id, opHash(request.op), f.lane.laneId)
    f.store.close()
    f.store = await openStore(join(f.root, 'state'), process.getuid?.())
    f.service = createLaneCommands({ ...f.ports, store: f.store })
    f.service.status(f.one.id, request.requestId)
    expect(f.last(request.requestId)?.status).toBe('unknown')
    await f.service.submit(f.one, request)
    expect(f.last(request.requestId)?.status).toBe('unknown')
    expect(f.command).not.toHaveBeenCalled()
  })

  it('times out at exactly the deadline and drops a late answer', async () => {
    const request = f.frame()
    const running = f.service.submit(f.one, request)
    const next = f.service.submit(f.one, f.frame({ type: 'abort' }, 2))
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs - 1)
    expect(f.last(request.requestId)).toBeUndefined()
    expect(f.command).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await running
    expect(f.last(request.requestId)?.status).toBe('unknown')
    expect(f.command).toHaveBeenCalledTimes(2)
    f.finish(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.receipts(request.requestId)).toHaveLength(1)
    f.service.status(f.one.id, request.requestId)
    expect(f.last(request.requestId)?.status).toBe('unknown')
    expect(f.logs.filter((l) => l.message === 'lane.command_late')).toEqual([
      {
        message: 'lane.command_late',
        data: { laneId: f.lane.laneId, requestId: request.requestId, op: 'prompt' },
      },
    ])
    f.finish(1)
    await next
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds the queue including running, permits resends when full, and leaves busy ids retryable', async () => {
    f.service = createLaneCommands(f.ports, { queueLimit: 2 })
    const first = f.service.submit(f.one, f.frame())
    const queuedFrame = f.frame({ type: 'abort' }, 2)
    const queued = f.service.submit(f.one, queuedFrame)
    const busyFrame = f.frame({ type: 'abort' }, 2)
    const busy = f.service.submit(f.one, busyFrame)
    expect(f.last(busyFrame.requestId)).toMatchObject({ code: 'busy' })
    await busy
    expect(f.store.getReceipt(busyFrame.requestId, f.one.id)).toBeNull()
    await f.service.submit(f.one, queuedFrame)
    expect(f.last(queuedFrame.requestId)?.status).toBe('pending')
    f.finish(0)
    await first
    f.finish(1)
    await queued
    const retry = f.service.submit(f.one, busyFrame)
    expect(f.command).toHaveBeenCalledTimes(3)
    f.finish(2)
    await retry
    expect(f.last(busyFrame.requestId)?.status).toBe('done')
    for (const queueLimit of [0, -1, 1.5, LANE_QUEUE_LIMIT + 1])
      expect(() => createLaneCommands(f.ports, { queueLimit })).toThrow('invalid lane queue limit')
  })

  it.each(['lane.resume', 'lane.stop'] as const)(
    'holds the dispatch queue for %s and counts queued jobs with outstanding work',
    async (type) => {
      if (type === 'lane.resume') f.sessions.clear()
      f.service = createLaneCommands(f.ports, { queueLimit: 2 })
      const response = deferred<void>()
      f.ports.resumeLane = async () => {
        await response.promise
        f.sessions.set(f.lane.laneId, 'resumed')
      }
      f.ports.stopLane = () => response.promise
      const running = f.service.submit(f.one, f.frame({ type }))
      const next = f.service.submit(f.one, f.frame({ type: 'abort' }, 2))
      const busy = f.frame({ type: 'abort' }, 2)
      await f.service.submit(f.one, busy)
      expect(f.last(busy.requestId)).toMatchObject({ code: 'busy' })
      expect(f.command).not.toHaveBeenCalled()
      response.release()
      await running
      await vi.advanceTimersByTimeAsync(0)
      expect(f.command).toHaveBeenCalledTimes(1)
      f.finish(0)
      await next
    },
  )

  it('dispatches a dialog answer while the prompt is waiting for it', async () => {
    const request = f.frame()
    const prompt = f.service.submit(f.one, request)
    f.respond.mockImplementation(() => f.finish(0))
    const response = f.frame(
      {
        type: 'extension_ui_response',
        response: { type: 'extension_ui_response', id: 'dialog', confirmed: true },
      },
      2,
    )
    const answer = f.service.submit(f.one, response)
    expect(f.respond).toHaveBeenCalledTimes(1)
    await Promise.all([prompt, answer])
    expect(f.last(request.requestId)?.status).toBe('done')
    expect(f.last(response.requestId)?.status).toBe('done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispatches abort immediately while compact is unanswered', async () => {
    const compact = f.service.submit(f.one, f.frame({ type: 'compact' }))
    const abort = f.service.submit(f.one, f.frame({ type: 'abort' }, 2))
    expect(f.command.mock.calls.map((call) => call[1].type)).toEqual(['compact', 'abort'])
    f.finish(1)
    await abort
    expect(f.pending).toHaveLength(2)
    f.finish(0)
    await compact
  })

  it('counts lingering ops at the limit, releases exactly one late slot and deletes only when empty', async () => {
    const deletion = vi.spyOn(Map.prototype, 'delete')
    try {
      const requests = Array.from({ length: LANE_QUEUE_LIMIT }, (_, index) =>
        f.frame({ type: 'abort' }, index === 0 ? 1 : 2),
      )
      const first = requests[0]
      if (!first) throw new Error('missing request')
      const running = requests.map((request) => f.service.submit(f.one, request))
      expect(f.command).toHaveBeenCalledTimes(LANE_QUEUE_LIMIT)
      await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
      await Promise.all(running)
      expect(requests.every((request) => f.last(request.requestId)?.status === 'unknown')).toBe(
        true,
      )
      expect(deletion.mock.calls.filter(([key]) => key === f.lane.laneId)).toHaveLength(0)
      const busy = f.frame({ type: 'abort' }, 2)
      const overflow = f.service.submit(f.one, busy)
      expect(f.last(busy.requestId)).toMatchObject({ code: 'busy' })
      await overflow
      expect(f.store.getReceipt(busy.requestId, f.one.id)).toBeNull()
      await f.service.submit(f.one, first)
      expect(f.last(first.requestId)?.status).toBe('unknown')
      f.finish(0)
      await vi.advanceTimersByTimeAsync(0)
      const replacement = f.service.submit(f.one, busy)
      expect(f.command).toHaveBeenCalledTimes(LANE_QUEUE_LIMIT + 1)
      const stillBusy = f.frame({ type: 'abort' }, 2)
      await f.service.submit(f.one, stillBusy)
      expect(f.last(stillBusy.requestId)).toMatchObject({ code: 'busy' })
      f.pending[1]?.reject(new Error('pi exited'))
      for (let i = 2; i <= LANE_QUEUE_LIMIT; i++) f.finish(i)
      await replacement
      await vi.advanceTimersByTimeAsync(0)
      expect(deletion.mock.calls.filter(([key]) => key === f.lane.laneId)).toHaveLength(1)
      expect(f.logs.filter((log) => log.message === 'lane.command_late')).toHaveLength(
        LANE_QUEUE_LIMIT,
      )
    } finally {
      deletion.mockRestore()
    }
  })

  it('runs different lanes concurrently', async () => {
    const other = f.store.ensureLane({
      repositoryId: f.lane.repositoryId,
      cwd: f.lane.cwd,
      sessionFile: join(f.root, 'other.jsonl'),
    })
    f.sessions.set(other.laneId, 'other')
    const a = f.service.submit(f.one, f.frame())
    const b = f.service.submit(
      f.two,
      f.frame({ type: 'prompt', message: 'other' }, 1, other.laneId),
    )
    expect(f.command).toHaveBeenCalledTimes(2)
    f.finish(0)
    f.finish(1)
    await Promise.all([a, b])
  })
})
