import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_LIMITS,
  parseHostFrame,
  type LaneEvent,
  type LaneOp,
  type LanePiOp,
  type Receipt,
} from '@phosphor/shared/host-protocol'
import type { HostRuntime } from '../session/runtime'
import { commandRefusal } from '../session/runtime'
import { openStore, opHash, type HostStore, type StoredLane } from './store'
import {
  createLaneCommands,
  LANE_QUEUE_LIMIT,
  receiptMessage,
  type LaneCommandClient,
  type LaneCommandFrame,
  type LaneCommandPorts,
} from './commands'

function deferred<T>() {
  let release: (value: T) => void = () => {
    throw new Error('not initialized')
  }
  let reject: (error: unknown) => void = () => {
    throw new Error('not initialized')
  }
  const promise = new Promise<T>((resolve, fail) => {
    release = resolve
    reject = fail
  })
  return { promise, release, reject }
}
type PiAnswer = Awaited<ReturnType<HostRuntime['command']>>
const success: PiAnswer = { type: 'response', command: 'prompt', success: true }
const one: LaneCommandClient = { id: randomUUID(), label: 'One', caps: ['sessions.control'] }
const two: LaneCommandClient = { id: randomUUID(), label: 'Two', caps: ['sessions.control'] }
let root: string
let store: HostStore
let lane: StoredLane
let ports: LaneCommandPorts
let service: ReturnType<typeof createLaneCommands>
let sent: { clientId: string; receipt: Receipt }[]
let events: { laneId: string; event: LaneEvent }[]
let order: string[]
let pending: ReturnType<typeof deferred<PiAnswer>>[]
let sessions: Map<string, string>
let logs: { message: string; data: unknown }[]
let command: ReturnType<typeof vi.fn<HostRuntime['command']>>
let respond: ReturnType<typeof vi.fn<HostRuntime['extensionUiResponse']>>
const frame = (
  op: LaneOp = { type: 'prompt', message: 'private prompt' },
  fence = 1,
  laneId = lane.laneId,
): LaneCommandFrame => ({ type: 'command', requestId: randomUUID(), laneId, fence, op })
const receipts = (requestId: string) =>
  sent.filter((s) => s.receipt.requestId === requestId).map((s) => s.receipt)
const last = (requestId: string) => receipts(requestId).at(-1)
function finish(index: number, value: PiAnswer = success) {
  const response = pending[index]
  if (!response) throw new Error('missing pi request')
  response.release(value)
}

beforeEach(async () => {
  vi.useFakeTimers()
  root = mkdtempSync(join(tmpdir(), 'host-commands-'))
  const repository = join(root, 'repo')
  mkdirSync(repository)
  store = await openStore(join(root, 'state'), process.getuid?.(), { now: () => Date.now() })
  const entry = store.syncRepositories([repository])[0]
  if (!entry) throw new Error('missing repository')
  lane = store.ensureLane({
    repositoryId: entry.id,
    cwd: repository,
    sessionFile: join(root, 'session.jsonl'),
  })
  sent = []
  events = []
  order = []
  pending = []
  logs = []
  sessions = new Map([[lane.laneId, 'pi-live']])
  command = vi.fn<HostRuntime['command']>((_id, cmd) => {
    order.push('run')
    const currentRequest = cmd.id ?? ''
    const recorded =
      store.getReceipt(currentRequest, one.id) ?? store.getReceipt(currentRequest, two.id)
    expect(recorded?.status).toBe('pending')
    const response = deferred<PiAnswer>()
    pending.push(response)
    return response.promise
  })
  respond = vi.fn()
  ports = {
    store,
    runtime: { command, extensionUiResponse: respond },
    resumeLane: vi.fn(async (saved) => {
      sessions.set(saved.laneId, 'resumed')
    }),
    stopLane: vi.fn(async (id) => {
      sessions.delete(id)
    }),
    sessionFor: (id) => sessions.get(id) ?? null,
    openDialogs: () => ['dialog'],
    summaryFor: (id) => {
      const saved = store.getLane(id)
      if (!saved) return null
      const { sessionFile: _sessionFile, removedAt: _removedAt, ...summary } = saved
      return { ...summary, activity: 'working' }
    },
    publish: (laneId, event) => {
      events.push({ laneId, event })
      order.push(event.kind)
    },
    deliver: (clientId, receipt) => {
      sent.push({ clientId, receipt })
    },
    now: () => Date.now(),
    log: (_scope, message, data) => {
      logs.push({ message, data })
    },
  }
  service = createLaneCommands(ports)
})
afterEach(() => {
  store.close()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('lane commands R7 ordering', () => {
  it('acquires once, publishes before run, rejects stale contenders and current-fence viewers', async () => {
    const first = frame()
    const second = frame()
    const a = service.submit(one, first)
    const b = service.submit(two, second)
    expect(order).toEqual(['control', 'run'])
    expect(store.getReceipt(first.requestId, one.id)?.status).toBe('pending')
    expect(command).toHaveBeenCalledTimes(1)
    expect(last(second.requestId)).toMatchObject({ code: 'stale-fence' })
    finish(0)
    await a
    expect(command).toHaveBeenCalledTimes(1)
    await b
    expect(last(second.requestId)).toMatchObject({
      status: 'rejected',
      code: 'stale-fence',
      control: { fence: 2, controller: { clientId: one.id } },
    })
    const retry = frame({ type: 'abort' }, 2)
    await service.submit(two, retry)
    expect(last(retry.requestId)).toMatchObject({
      code: 'not-controller',
      control: { controller: { clientId: one.id } },
    })
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('admits takeover while a prompt is in flight, then rejects the old controller', async () => {
    const original = service.submit(one, frame())
    const take = frame({ type: 'control.take' })
    const takeover = service.submit(two, take)
    const stale = frame({ type: 'abort' }, 2)
    const old = service.submit(one, stale)
    const next = service.submit(two, frame({ type: 'abort' }, 3))
    await takeover
    await old
    expect(pending).toHaveLength(2)
    expect(command).toHaveBeenCalledTimes(2)
    finish(0)
    await original
    expect(last(take.requestId)).toMatchObject({ status: 'done', fence: 3 })
    expect(last(stale.requestId)).toMatchObject({ code: 'stale-fence' })
    expect(order).toEqual(['control', 'run', 'control', 'run'])
    finish(1)
    await next
  })

  it('runs duplicate ids once, gives pending then the same terminal, and refuses op/client conflicts', async () => {
    const request = frame()
    const running = service.submit(one, request)
    await service.submit(one, request)
    expect(last(request.requestId)).toMatchObject({ status: 'pending' })
    service.status(one.id, request.requestId)
    expect(last(request.requestId)).toMatchObject({ status: 'pending' })
    finish(0)
    await running
    const terminal = last(request.requestId)
    await service.submit(one, request)
    expect(last(request.requestId)).toEqual(terminal)
    expect(command).toHaveBeenCalledTimes(1)
    await service.submit(one, { ...request, op: { type: 'abort' } })
    expect(last(request.requestId)).toMatchObject({ code: 'conflict' })
    await service.submit(two, request)
    expect(sent.at(-1)).toMatchObject({ clientId: two.id, receipt: { code: 'conflict' } })
    service.status(two.id, request.requestId)
    expect(sent.at(-1)).toEqual({
      clientId: two.id,
      receipt: { requestId: request.requestId, status: 'unknown' },
    })
    service.status(one.id, randomUUID())
    expect(sent.at(-1)?.receipt.status).toBe('unknown')
  })

  it('conflicts on another client request id without exposing the pending receipt', async () => {
    const request = frame()
    const running = service.submit(one, request)
    const collision = service.submit(two, request)
    expect(sent.at(-1)).toMatchObject({ clientId: two.id, receipt: { code: 'conflict' } })
    await collision
    service.status(two.id, request.requestId)
    expect(last(request.requestId)?.status).toBe('unknown')
    expect(command).toHaveBeenCalledTimes(1)
    finish(0)
    await running
  })

  it('reopens an interrupted request as unknown and never replays it', async () => {
    const request = frame()
    store.beginRequest(request.requestId, one.id, opHash(request.op), lane.laneId)
    store.close()
    store = await openStore(join(root, 'state'), process.getuid?.())
    service = createLaneCommands({ ...ports, store })
    service.status(one.id, request.requestId)
    expect(last(request.requestId)?.status).toBe('unknown')
    await service.submit(one, request)
    expect(last(request.requestId)?.status).toBe('unknown')
    expect(command).not.toHaveBeenCalled()
  })

  it('times out at exactly the deadline and drops a late answer', async () => {
    const request = frame()
    const running = service.submit(one, request)
    const next = service.submit(one, frame({ type: 'abort' }, 2))
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs - 1)
    expect(last(request.requestId)).toBeUndefined()
    expect(command).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await running
    expect(last(request.requestId)?.status).toBe('unknown')
    expect(command).toHaveBeenCalledTimes(2)
    finish(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(receipts(request.requestId)).toHaveLength(1)
    service.status(one.id, request.requestId)
    expect(last(request.requestId)?.status).toBe('unknown')
    expect(logs.filter((l) => l.message === 'lane.command_late')).toEqual([
      {
        message: 'lane.command_late',
        data: { laneId: lane.laneId, requestId: request.requestId, op: 'prompt' },
      },
    ])
    finish(1)
    await next
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds the queue including running, permits resends when full, and leaves busy ids retryable', async () => {
    service = createLaneCommands(ports, { queueLimit: 2 })
    const first = service.submit(one, frame())
    const queuedFrame = frame({ type: 'abort' }, 2)
    const queued = service.submit(one, queuedFrame)
    const busyFrame = frame({ type: 'abort' }, 2)
    const busy = service.submit(one, busyFrame)
    expect(last(busyFrame.requestId)).toMatchObject({ code: 'busy' })
    await busy
    expect(store.getReceipt(busyFrame.requestId, one.id)).toBeNull()
    await service.submit(one, queuedFrame)
    expect(last(queuedFrame.requestId)?.status).toBe('pending')
    finish(0)
    await first
    finish(1)
    await queued
    const retry = service.submit(one, busyFrame)
    expect(command).toHaveBeenCalledTimes(3)
    finish(2)
    await retry
    expect(last(busyFrame.requestId)?.status).toBe('done')
    for (const queueLimit of [0, -1, 1.5, LANE_QUEUE_LIMIT + 1])
      expect(() => createLaneCommands(ports, { queueLimit })).toThrow('invalid lane queue limit')
  })

  it.each(['lane.resume', 'lane.stop'] as const)(
    'holds the dispatch queue for %s and counts queued jobs with outstanding work',
    async (type) => {
      if (type === 'lane.resume') sessions.clear()
      service = createLaneCommands(ports, { queueLimit: 2 })
      const response = deferred<void>()
      ports.resumeLane = async () => {
        await response.promise
        sessions.set(lane.laneId, 'resumed')
      }
      ports.stopLane = () => response.promise
      const running = service.submit(one, frame({ type }))
      const next = service.submit(one, frame({ type: 'abort' }, 2))
      const busy = frame({ type: 'abort' }, 2)
      await service.submit(one, busy)
      expect(last(busy.requestId)).toMatchObject({ code: 'busy' })
      expect(command).not.toHaveBeenCalled()
      response.release()
      await running
      await vi.advanceTimersByTimeAsync(0)
      expect(command).toHaveBeenCalledTimes(1)
      finish(0)
      await next
    },
  )

  it('dispatches a dialog answer while the prompt is waiting for it', async () => {
    const request = frame()
    const prompt = service.submit(one, request)
    respond.mockImplementation(() => finish(0))
    const response = frame(
      {
        type: 'extension_ui_response',
        response: { type: 'extension_ui_response', id: 'dialog', confirmed: true },
      },
      2,
    )
    const answer = service.submit(one, response)
    expect(respond).toHaveBeenCalledTimes(1)
    await Promise.all([prompt, answer])
    expect(last(request.requestId)?.status).toBe('done')
    expect(last(response.requestId)?.status).toBe('done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispatches abort immediately while compact is unanswered', async () => {
    const compact = service.submit(one, frame({ type: 'compact' }))
    const abort = service.submit(one, frame({ type: 'abort' }, 2))
    expect(command.mock.calls.map((call) => call[1].type)).toEqual(['compact', 'abort'])
    finish(1)
    await abort
    expect(pending).toHaveLength(2)
    finish(0)
    await compact
  })

  it('counts lingering ops at the limit, releases exactly one late slot and deletes only when empty', async () => {
    const deletion = vi.spyOn(Map.prototype, 'delete')
    try {
      const requests = Array.from({ length: LANE_QUEUE_LIMIT }, (_, index) =>
        frame({ type: 'abort' }, index === 0 ? 1 : 2),
      )
      const first = requests[0]
      if (!first) throw new Error('missing request')
      const running = requests.map((request) => service.submit(one, request))
      expect(command).toHaveBeenCalledTimes(LANE_QUEUE_LIMIT)
      await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
      await Promise.all(running)
      expect(requests.every((request) => last(request.requestId)?.status === 'unknown')).toBe(true)
      expect(deletion.mock.calls.filter(([key]) => key === lane.laneId)).toHaveLength(0)
      const busy = frame({ type: 'abort' }, 2)
      const overflow = service.submit(one, busy)
      expect(last(busy.requestId)).toMatchObject({ code: 'busy' })
      await overflow
      expect(store.getReceipt(busy.requestId, one.id)).toBeNull()
      await service.submit(one, first)
      expect(last(first.requestId)?.status).toBe('unknown')
      finish(0)
      await vi.advanceTimersByTimeAsync(0)
      const replacement = service.submit(one, busy)
      expect(command).toHaveBeenCalledTimes(LANE_QUEUE_LIMIT + 1)
      const stillBusy = frame({ type: 'abort' }, 2)
      await service.submit(one, stillBusy)
      expect(last(stillBusy.requestId)).toMatchObject({ code: 'busy' })
      pending[1]?.reject(new Error('pi exited'))
      for (let i = 2; i <= LANE_QUEUE_LIMIT; i++) finish(i)
      await replacement
      await vi.advanceTimersByTimeAsync(0)
      expect(deletion.mock.calls.filter(([key]) => key === lane.laneId)).toHaveLength(1)
      expect(logs.filter((log) => log.message === 'lane.command_late')).toHaveLength(
        LANE_QUEUE_LIMIT,
      )
    } finally {
      deletion.mockRestore()
    }
  })

  it('runs different lanes concurrently', async () => {
    const other = store.ensureLane({
      repositoryId: lane.repositoryId,
      cwd: lane.cwd,
      sessionFile: join(root, 'other.jsonl'),
    })
    sessions.set(other.laneId, 'other')
    const a = service.submit(one, frame())
    const b = service.submit(two, frame({ type: 'prompt', message: 'other' }, 1, other.laneId))
    expect(command).toHaveBeenCalledTimes(2)
    finish(0)
    finish(1)
    await Promise.all([a, b])
  })
})

describe('lane command guards and operations', () => {
  it('republishes durable control before the next op after a failed admission publication', async () => {
    const publish = ports.publish
    const deletion = vi.spyOn(Map.prototype, 'delete')
    ports.publish = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('stream failed')
      })
      .mockImplementation(publish)
    const first = frame()
    try {
      await service.submit(one, first)
      expect(last(first.requestId)).toMatchObject({
        status: 'failed',
        error: {
          code: 'internal',
          message: "the lane's control change could not be published",
        },
      })
      expect(command).not.toHaveBeenCalled()
      expect(store.getLane(lane.laneId)?.control.fence).toBe(2)
      expect(deletion.mock.calls.filter(([key]) => key === lane.laneId)).toHaveLength(0)
    } finally {
      deletion.mockRestore()
    }
    const next = service.submit(one, frame({ type: 'abort' }, 2))
    expect(order).toEqual(['control', 'run'])
    expect(events[0]?.event).toMatchObject({ kind: 'control', control: { fence: 2 } })
    finish(0)
    await next
  })

  it('clears unpublished control for a pruned lane and deletes its queue after outstanding work settles', async () => {
    const deletion = vi.spyOn(Map.prototype, 'delete')
    const running = service.submit(one, frame())
    ports.publish = () => {
      throw new Error('stream failed')
    }
    try {
      await service.submit(two, frame({ type: 'control.take' }))
      store.markRemoved(lane.laneId)
      store.pruneRemovedLanes(Date.now() + 31 * 24 * 60 * 60 * 1000)
      expect(store.getLane(lane.laneId)).toBeNull()
      const missing = frame({ type: 'abort' }, 3)
      await service.submit(two, missing)
      expect(last(missing.requestId)).toMatchObject({ status: 'rejected', code: 'unknown-lane' })
      expect(store.getReceipt(missing.requestId, two.id)).toEqual(last(missing.requestId))
      expect(command).toHaveBeenCalledTimes(1)
      expect(deletion.mock.calls.filter(([key]) => key === lane.laneId)).toHaveLength(0)
      finish(0)
      await running
      expect(deletion.mock.calls.filter(([key]) => key === lane.laneId)).toHaveLength(1)
    } finally {
      deletion.mockRestore()
    }
  })

  it('fails closed when control republication keeps failing', async () => {
    ports.publish = () => {
      throw new Error('stream failed')
    }
    await service.submit(one, frame())
    const next = frame({ type: 'abort' }, 2)
    await service.submit(one, next)
    expect(last(next.requestId)).toMatchObject({
      status: 'failed',
      error: {
        code: 'internal',
        message: "the lane's control change could not be published",
      },
    })
    expect(command).not.toHaveBeenCalled()
  })

  it.each(['control.take', 'control.release'] as const)(
    'keeps %s done after failed publication and republishes fresh control before later work',
    async (type) => {
      if (type === 'control.release')
        store.takeControl(lane.laneId, { clientId: one.id, label: one.label })
      const publish = ports.publish
      ports.publish = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('stream failed')
        })
        .mockImplementation(publish)
      const request = frame({ type }, type === 'control.release' ? 2 : 1)
      await service.submit(one, request)
      const fence = type === 'control.release' ? 3 : 2
      expect(last(request.requestId)).toMatchObject({ status: 'done', fence })
      const next = service.submit(one, frame({ type: 'abort' }, fence))
      expect(order).toEqual(
        type === 'control.release' ? ['control', 'control', 'run'] : ['control', 'run'],
      )
      expect(events[0]?.event).toMatchObject({ kind: 'control', control: { fence } })
      finish(0)
      await next
    },
  )

  it.each(['dialog-resolved', 'summary'] as const)(
    'does not change done on failed %s publication',
    async (kind) => {
      store.takeControl(lane.laneId, { clientId: one.id, label: one.label })
      ports.publish = () => {
        throw new Error('private stream error')
      }
      const request = frame(
        kind === 'summary'
          ? { type: 'lane.markRead', upTo: 0 }
          : {
              type: 'extension_ui_response',
              response: { type: 'extension_ui_response', id: 'dialog', confirmed: true },
            },
        2,
      )
      await service.submit(one, request)
      expect(last(request.requestId)?.status).toBe('done')
      expect(logs).toContainEqual({
        message: 'lane.publish_failed',
        data: { laneId: lane.laneId, kind },
      })
      expect(JSON.stringify(logs)).not.toContain('private stream error')
    },
  )

  it('requires control capability before recording', async () => {
    const request = frame()
    const submitted = service.submit({ ...one, caps: ['sessions.read'] }, request)
    expect(command).not.toHaveBeenCalled()
    await submitted
    expect(last(request.requestId)).toMatchObject({ code: 'forbidden' })
    expect(store.getReceipt(request.requestId, one.id)).toBeNull()
    expect(events).toEqual([])
    expect(command).not.toHaveBeenCalled()
  })

  it('records unsupported creation, missing lanes, stopped pi and missing fences', async () => {
    for (const [request, code] of [
      [
        {
          type: 'command',
          requestId: randomUUID(),
          op: { type: 'lane.create', repositoryId: lane.repositoryId, worktree: null },
        },
        'unsupported',
      ],
      [frame({ type: 'abort' }, 1, randomUUID()), 'unknown-lane'],
      [{ type: 'command', requestId: randomUUID(), op: { type: 'lane.resume' } }, 'unknown-lane'],
      [
        { type: 'command', requestId: randomUUID(), laneId: lane.laneId, op: { type: 'abort' } },
        'bad-request',
      ],
    ] satisfies [LaneCommandFrame, string][]) {
      await service.submit(one, request)
      expect(store.getReceipt(request.requestId, one.id)).toMatchObject({
        status: 'rejected',
        code,
      })
    }
    sessions.clear()
    const stopped = frame()
    await service.submit(one, stopped)
    expect(last(stopped.requestId)).toMatchObject({ code: 'lane-stopped' })
    expect(store.getLane(lane.laneId)?.control.fence).toBe(1)
  })

  it('rejects a refusable pi operation before admission, even on an empty controller', async () => {
    service = createLaneCommands({ ...ports, refusal: () => 'private reason' })
    const request = frame()
    const submitted = service.submit(one, request)
    expect(command).not.toHaveBeenCalled()
    await submitted
    expect(store.getReceipt(request.requestId, one.id)).toMatchObject({ code: 'unsupported' })
    expect(store.getLane(lane.laneId)?.control).toEqual({ fence: 1, controller: null })
    expect(command).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(JSON.stringify(logs)).not.toContain('private reason')
  })

  it('pins every lane pi op as non-refusable on the Host; a change now answers rejected unsupported', () => {
    const ops = [
      { type: 'prompt', message: 'x' },
      { type: 'steer', message: 'x' },
      { type: 'follow_up', message: 'x' },
      { type: 'abort' },
      { type: 'abort_retry' },
      { type: 'set_model', provider: 'p', modelId: 'm' },
      { type: 'set_thinking_level', level: 'off' },
      { type: 'compact' },
      { type: 'set_session_name', name: 'x' },
    ] satisfies LanePiOp[]
    for (const op of ops) expect(commandRefusal(op)).toBeNull()
  })

  it('admits dialog answers only for the controller, refuses closed ids and publishes resolution after success', async () => {
    store.takeControl(lane.laneId, { clientId: one.id, label: one.label })
    const answer: LaneOp = {
      type: 'extension_ui_response',
      response: { type: 'extension_ui_response', id: 'dialog', confirmed: true },
    }
    const viewer = frame(answer, 2)
    await service.submit(two, viewer)
    expect(last(viewer.requestId)).toMatchObject({ code: 'not-controller' })
    expect(respond).not.toHaveBeenCalled()
    const resolved = deferred<void>()
    // HostRuntime responds synchronously; a throwing response is tested separately.
    respond.mockImplementation(() => {
      expect(events).toEqual([])
      resolved.release()
    })
    await service.submit(one, frame(answer, 2))
    await resolved.promise
    expect(respond).toHaveBeenCalledWith('pi-live', answer.response)
    expect(events.map((e) => e.event)).toEqual([{ kind: 'dialog-resolved', dialogId: 'dialog' }])
    const closed = frame(
      { ...answer, response: { type: 'extension_ui_response', id: 'closed', cancelled: true } },
      2,
    )
    await service.submit(one, closed)
    expect(last(closed.requestId)).toMatchObject({ code: 'bad-request' })
    expect(respond).toHaveBeenCalledTimes(1)
  })

  it('maps thrown transport commands to unknown and still runs the next queued command', async () => {
    const request = frame()
    const a = service.submit(one, request)
    const b = service.submit(one, frame({ type: 'abort' }, 2))
    pending[0]?.reject(new Error('private error'))
    await a
    expect(last(request.requestId)?.status).toBe('unknown')
    service.status(one.id, request.requestId)
    expect(last(request.requestId)?.status).toBe('unknown')
    expect(command).toHaveBeenCalledTimes(2)
    finish(1)
    await b
    expect(logs).toContainEqual({
      message: 'lane.command',
      data: expect.objectContaining({ status: 'unknown', reason: 'transport' }),
    })
    expect(JSON.stringify(logs)).not.toContain('private error')
  })

  it('does not resolve a dialog after a thrown response', async () => {
    respond.mockImplementation(() => {
      throw new Error('private response')
    })
    const request = frame({
      type: 'extension_ui_response',
      response: { type: 'extension_ui_response', id: 'dialog', confirmed: true },
    })
    await service.submit(one, request)
    expect(last(request.requestId)?.status).toBe('unknown')
    expect(events.map((e) => e.event.kind)).toEqual(['control'])
  })

  it('caps pi errors, drops oversize data in delivered receipts and logs no content', async () => {
    const request = { ...frame(), trace: '1234567890abcdef' }
    const a = service.submit(one, request)
    finish(0, {
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'private error'.repeat(HOST_LIMITS.messageChars),
    })
    await a
    expect(last(request.requestId)).toMatchObject({
      status: 'failed',
      error: { code: 'pi-error', message: expect.any(String) },
    })
    const receipt = last(request.requestId)
    if (receipt?.status !== 'failed') throw new Error('missing failure')
    expect(receipt.error.message).toHaveLength(HOST_LIMITS.messageChars)
    const huge = frame({ type: 'abort' }, 2)
    const b = service.submit(one, huge)
    finish(1, { ...success, data: { text: 'x'.repeat(HOST_LIMITS.receiptDataBytes) } })
    await b
    expect(last(huge.requestId)).toEqual({ requestId: huge.requestId, status: 'done' })
    expect(last(huge.requestId)).toEqual(store.getReceipt(huge.requestId, one.id))
    expect(JSON.stringify(logs)).not.toMatch(/private prompt|private error/)
    expect(logs[0]?.data).toMatchObject({
      trace: request.trace,
      status: 'failed',
      code: 'pi-error',
    })
  })

  it('normalizes pi error text into a stored, wire-valid failure', async () => {
    const request = frame()
    const running = service.submit(one, request)
    finish(0, { type: 'response', command: 'prompt', success: false, error: 'line one\nline two' })
    await running
    const receipt = last(request.requestId)
    expect(receipt).toMatchObject({
      status: 'failed',
      error: { code: 'pi-error', message: 'line one line two' },
    })
    expect(store.getReceipt(request.requestId, one.id)).toEqual(receipt)
    service.status(one.id, request.requestId)
    expect(last(request.requestId)).toEqual(receipt)
    expect(parseHostFrame(JSON.stringify({ type: 'receipt', receipt })).ok).toBe(true)
  })

  it.each([HOST_LIMITS.messageChars, HOST_LIMITS.messageChars + 1])(
    'keeps pi error messages bounded at %i characters',
    async (length) => {
      const request = frame()
      const running = service.submit(one, request)
      finish(0, { type: 'response', command: 'prompt', success: false, error: 'x'.repeat(length) })
      await running
      expect(last(request.requestId)).toMatchObject({
        status: 'failed',
        error: { message: 'x'.repeat(HOST_LIMITS.messageChars) },
      })
    },
  )

  it.each([
    { type: 'prompt', message: 'x' },
    { type: 'steer', message: 'x' },
    { type: 'follow_up', message: 'x' },
    { type: 'abort' },
    { type: 'abort_retry' },
    { type: 'set_model', provider: 'p', modelId: 'm' },
    { type: 'set_thinking_level', level: 'off' },
    { type: 'compact', customInstructions: 'x' },
    { type: 'set_session_name', name: 'x' },
  ] satisfies LanePiOp[])(
    'forwards $type fields with a Host correlation id and no summary',
    async (op) => {
      const request = frame(op)
      const running = service.submit(one, request)
      expect(command).toHaveBeenCalledWith('pi-live', { ...op, id: request.requestId })
      finish(0)
      await running
      expect(events.map((e) => e.event.kind)).toEqual(['control'])
    },
  )

  it('takes and releases control, markRead is unfenced and keeps counters bounded', async () => {
    const a = frame({ type: 'control.take' })
    const b = frame({ type: 'control.take' })
    await Promise.all([service.submit(one, a), service.submit(two, b)])
    expect(last(a.requestId)).toMatchObject({ fence: 2 })
    expect(last(b.requestId)).toMatchObject({ fence: 3 })
    const staleRelease = frame({ type: 'control.release' }, 2)
    await service.submit(one, staleRelease)
    expect(last(staleRelease.requestId)).toMatchObject({ code: 'stale-fence' })
    const viewer = frame({ type: 'control.release' }, 3)
    await service.submit(one, viewer)
    expect(last(viewer.requestId)).toMatchObject({ code: 'not-controller' })
    await service.submit(two, frame({ type: 'control.release' }, 3))
    expect(store.getLane(lane.laneId)?.control).toEqual({ fence: 4, controller: null })
    const emptyRelease = frame({ type: 'control.release' }, 4)
    await service.submit(one, emptyRelease)
    expect(last(emptyRelease.requestId)).toMatchObject({ code: 'not-controller' })
    expect(store.getLane(lane.laneId)?.control.fence).toBe(4)
    store.bumpAttention(lane.laneId)
    await service.submit(one, frame({ type: 'lane.markRead', upTo: 10 }, 1))
    expect(events.at(-1)?.event).toMatchObject({
      kind: 'summary',
      summary: { activity: 'working', read: 1, attention: 1 },
    })
    expect(store.getLane(lane.laneId)?.control.fence).toBe(4)
    const summaryEvent = events.at(-1)?.event
    if (summaryEvent?.kind !== 'summary') throw new Error('missing summary')
    expect(summaryEvent.summary).not.toHaveProperty('sessionFile')
    expect(summaryEvent.summary).not.toHaveProperty('removedAt')
  })

  it('marks read even when the projection has no summary', async () => {
    ports.summaryFor = () => null
    store.bumpAttention(lane.laneId)
    const request = frame({ type: 'lane.markRead', upTo: 1 })
    await service.submit(two, request)
    expect(store.getLane(lane.laneId)?.read).toBe(1)
    expect(last(request.requestId)?.status).toBe('done')
    expect(events).toEqual([])
  })

  it('maps store started-row capacity to unrecorded busy', async () => {
    store.close()
    store = await openStore(join(root, 'state'), process.getuid?.(), {
      limits: { receiptsKept: 1 },
    })
    service = createLaneCommands({ ...ports, store })
    const candidates = [frame({ type: 'control.take' }), frame({ type: 'control.take' })].sort(
      (a, b) => a.requestId.localeCompare(b.requestId),
    )
    const request = candidates[0]
    const older = candidates[1]
    if (!request || !older) throw new Error('missing tie ids')
    const outstanding = older.requestId
    store.beginRequest(outstanding, one.id, opHash({ type: 'abort' }), lane.laneId)
    await service.submit(one, request)
    expect(last(request.requestId)).toMatchObject({ code: 'busy' })
    expect(store.getReceipt(request.requestId, one.id)).toBeNull()
    store.finishRequest(outstanding, { requestId: outstanding, status: 'unknown' })
    await service.submit(one, request)
    expect(last(request.requestId)?.status).toBe('done')
    expect(store.getReceipt(request.requestId, one.id)).toBeNull()
  })

  it('delivers a settled pi receipt even when every finishRequest throws', async () => {
    const finishRequest = vi.spyOn(store, 'finishRequest').mockImplementation(() => {
      throw new Error('private storage failure')
    })
    try {
      const request = frame()
      const running = service.submit(one, request)
      finish(0)
      await running
      expect(last(request.requestId)).toEqual({ requestId: request.requestId, status: 'done' })
      expect(logs).toContainEqual({
        message: 'lane.receipt_unrecorded',
        data: { laneId: lane.laneId, requestId: request.requestId },
      })
      service.status(one.id, request.requestId)
      expect(last(request.requestId)?.status).toBe('pending')
      store.markInterrupted()
      service.status(one.id, request.requestId)
      expect(last(request.requestId)?.status).toBe('unknown')
      expect(JSON.stringify(logs)).not.toContain('private storage failure')
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      finishRequest.mockRestore()
    }
  })

  it('delivers unknown for invalid runtime data without throwing or leaving the submission unresolved', async () => {
    const request = frame()
    const running = service.submit(one, request)
    finish(0, {
      ...success,
      data: {
        get text(): string {
          throw new Error('invalid runtime data')
        },
      },
    })
    await running
    expect(last(request.requestId)).toEqual({ requestId: request.requestId, status: 'unknown' })
    expect(store.getReceipt(request.requestId, one.id)).toEqual(last(request.requestId))
    expect(logs).toContainEqual({
      message: 'lane.command',
      data: expect.objectContaining({ status: 'unknown' }),
    })
  })

  it('resolves synchronous control.take and drains the next queued job when every finishRequest throws', async () => {
    const deletion = vi.spyOn(Map.prototype, 'delete')
    const finishRequest = vi.spyOn(store, 'finishRequest').mockImplementation(() => {
      throw new Error('storage failed')
    })
    sessions.clear()
    const response = deferred<void>()
    ports.resumeLane = () => response.promise
    try {
      const running = service.submit(one, frame({ type: 'lane.resume' }))
      const take = frame({ type: 'control.take' })
      let takeResolved = false
      const taken = service.submit(one, take).then(() => {
        takeResolved = true
      })
      const read = frame({ type: 'lane.markRead', upTo: 0 })
      let readResolved = false
      const next = service.submit(one, read).then(() => {
        readResolved = true
      })
      expect(last(take.requestId)).toBeUndefined()
      response.release()
      await vi.advanceTimersByTimeAsync(0)
      expect(takeResolved).toBe(true)
      expect(readResolved).toBe(true)
      expect(last(take.requestId)).toMatchObject({ status: 'done', fence: 3 })
      expect(last(read.requestId)?.status).toBe('done')
      expect(deletion.mock.calls.filter(([key]) => key === lane.laneId)).toHaveLength(1)
      await Promise.all([running, taken, next])
    } finally {
      finishRequest.mockRestore()
      deletion.mockRestore()
    }
  })

  it('delivers and drains when the terminal clock throws', async () => {
    const take = frame({ type: 'control.take' })
    ports.now = vi
      .fn(() => Date.now())
      .mockReturnValueOnce(Date.now())
      .mockImplementationOnce(() => {
        throw new Error('clock failed')
      })
    await service.submit(one, take)
    expect(receipts(take.requestId)).toEqual([
      { requestId: take.requestId, status: 'done', fence: 2 },
    ])
    expect(
      logs.filter((entry) => entry.message === 'lane.command').map((entry) => entry.data),
    ).toEqual([expect.objectContaining({ ms: undefined })])
    const request = frame({ type: 'abort' }, 2)
    const next = service.submit(one, request)
    expect(command).toHaveBeenCalledTimes(1)
    finish(0)
    await next
    expect(last(request.requestId)?.status).toBe('done')
  })

  it('delivery and logging failures do not strand the lane queue', async () => {
    ports.deliver = () => {
      throw new Error('disconnected')
    }
    ports.log = () => {
      throw new Error('logger unavailable')
    }
    const first = frame()
    const a = service.submit(one, first)
    const b = service.submit(one, frame({ type: 'abort' }, 2))
    finish(0)
    await a
    expect(store.getReceipt(first.requestId, one.id)?.status).toBe('done')
    expect(command).toHaveBeenCalledTimes(2)
    finish(1)
    await b
  })

  it('resumes and stops through lane ports with idempotent no-ops', async () => {
    store.takeControl(lane.laneId, { clientId: one.id, label: one.label })
    await service.submit(one, frame({ type: 'lane.resume' }, 2))
    expect(ports.resumeLane).not.toHaveBeenCalled()
    await service.submit(one, frame({ type: 'lane.stop' }, 2))
    await service.submit(one, frame({ type: 'lane.stop' }, 2))
    expect(ports.stopLane).toHaveBeenCalledTimes(1)
    await service.submit(one, frame({ type: 'lane.resume' }, 2))
    expect(ports.resumeLane).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFile: lane.sessionFile }),
    )
  })

  it.each(['lane.resume', 'lane.stop'] as const)(
    'bounds %s waits and keeps late receipts unknown',
    async (type) => {
      if (type === 'lane.resume') sessions.clear()
      const response = deferred<void>()
      ports.resumeLane = () => response.promise
      ports.stopLane = () => response.promise
      const request = frame({ type })
      const running = service.submit(one, request)
      await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
      await running
      expect(last(request.requestId)?.status).toBe('unknown')
      response.release()
      await vi.advanceTimersByTimeAsync(0)
      expect(store.getReceipt(request.requestId, one.id)?.status).toBe('unknown')
    },
  )

  it.each(['lane.resume', 'lane.stop'] as const)(
    'uses fixed %s errors and token-only error codes',
    async (type) => {
      if (type === 'lane.resume') sessions.clear()
      const fail = async () => {
        throw { code: 'bad code with spaces', message: 'private failure' }
      }
      ports.resumeLane = fail
      ports.stopLane = fail
      const request = frame({ type })
      await service.submit(one, request)
      expect(last(request.requestId)).toMatchObject({
        status: 'failed',
        error: {
          code: 'internal',
          message: type === 'lane.resume' ? 'the lane could not start' : 'the lane could not stop',
        },
      })
      expect(JSON.stringify(logs)).not.toMatch(/bad code with spaces|private failure/)
    },
  )
})

describe('receiptMessage matches store and wire limits', () => {
  it('replaces rejected text characters with spaces and trims the ends', () => {
    const controls = [10, 9, 0, 127, 0x2028, 0x2029]
    expect(
      receiptMessage(
        '  ' + controls.map((code) => `a${String.fromCharCode(code)}b`).join('') + '  ',
      ),
    ).toBe('a ba ba ba ba ba b')
  })
  it.each(['', String.fromCharCode(0, 9, 10, 127, 0x2028, 0x2029)])(
    'uses a wire-valid fixed sentence for empty normalized text',
    (raw) => {
      const message = receiptMessage(raw)
      expect(message).toBe('pi reported an error')
      expect(
        parseHostFrame(
          JSON.stringify({
            type: 'receipt',
            receipt: {
              requestId: randomUUID(),
              status: 'failed',
              error: { code: 'pi-error', message },
            },
          }),
        ).ok,
      ).toBe(true)
    },
  )
  it('does not split a surrogate pair at the UTF-16 limit', () => {
    expect(receiptMessage('x'.repeat(HOST_LIMITS.messageChars - 1) + '🙂')).toBe(
      'x'.repeat(HOST_LIMITS.messageChars - 1),
    )
  })
  it.each([null, undefined, 123, {}])('uses fixed text for non-string input', (raw) => {
    expect(receiptMessage(raw)).toBe('pi reported an error')
  })
})
