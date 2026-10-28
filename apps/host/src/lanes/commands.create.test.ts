import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, parseHostFrame, type LaneOp } from '@phosphor/shared/host-protocol'
import * as folders from './worktree'
import { LaneCapacityReached } from './store'
import { type LaneCommandFrame } from './commands'
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

describe('lane.create', () => {
  const create = (
    overrides: Partial<Extract<LaneOp, { type: 'lane.create' }>> = {},
  ): LaneCommandFrame => ({
    type: 'command',
    requestId: randomUUID(),
    op: { type: 'lane.create', repositoryId: f.lane.repositoryId, worktree: null, ...overrides },
  })
  it('records before start, makes the creator controller at fence 1, publishes control then summary, and dedupes', async () => {
    const request = create({ name: 'Created' })
    vi.mocked(f.ports.sessions.start).mockImplementation(async () => {
      expect(f.store.getReceipt(request.requestId, f.one.id)?.status).toBe('pending')
      return { sessionId: 'new', sessionFile: null }
    })
    await f.service.submit(f.one, request)
    const receipt = f.last(request.requestId)
    expect(receipt).toMatchObject({ status: 'done', fence: 1 })
    if (receipt?.status !== 'done' || !receipt.laneId) throw new Error('missing created lane')
    expect(f.store.getLane(receipt.laneId)).toMatchObject({
      title: 'Created',
      control: { fence: 1, controller: { clientId: f.one.id, label: f.one.label } },
    })
    expect(f.events.map((e) => e.event.kind)).toEqual(['control', 'summary'])
    expect(parseHostFrame(JSON.stringify({ type: 'receipt', receipt }))).not.toBeNull()
    await f.service.submit(f.one, request)
    expect(f.last(request.requestId)).toEqual(receipt)
    expect(f.ports.sessions.start).toHaveBeenCalledTimes(1)
  })
  it('rejects laneId, unknown and inactive repositories, and unnormalized or oversized names', async () => {
    const requests = [
      { ...create(), laneId: f.lane.laneId },
      create({ repositoryId: '0000000000000000' }),
      ...[' padded ', '', 'bad\nname', 'x'.repeat(HOST_LIMITS.labelChars + 1)].map((name) =>
        create({ name }),
      ),
    ]
    for (const request of requests) {
      await f.service.submit(f.one, request)
      expect(f.last(request.requestId)).toMatchObject({ status: 'rejected', code: 'bad-request' })
    }
    f.store.syncRepositories([])
    const inactive = create()
    await f.service.submit(f.one, inactive)
    expect(f.last(inactive.requestId)).toMatchObject({ code: 'bad-request' })
    expect(f.ports.sessions.start).not.toHaveBeenCalled()
  })
  it('accepts the exact name limit and refuses the lane cap before starting anything', async () => {
    await f.service.submit(f.one, create({ name: 'x'.repeat(HOST_LIMITS.labelChars) }))
    expect(f.ports.sessions.start).toHaveBeenCalledTimes(1)
    vi.spyOn(f.store, 'listLanes').mockReturnValue(
      Array.from({ length: f.store.limits.lanesPerHost }, () => f.lane),
    )
    const request = create()
    await f.service.submit(f.one, request)
    expect(f.last(request.requestId)).toMatchObject({ code: 'too-many-requests' })
    expect(f.ports.sessions.start).toHaveBeenCalledTimes(1)
  })
  it('returns fixed folder errors and generic start errors, logging safe codes only', async () => {
    const invalid = create({ worktree: { branch: 'bad..name' } })
    await f.service.submit(f.one, invalid)
    expect(f.last(invalid.requestId)).toMatchObject({
      status: 'failed',
      error: { code: 'internal', message: 'That branch name is not valid.' },
    })
    for (const code of ['SAFE_CODE', 'private/path', 'x'.repeat(65)]) {
      vi.mocked(f.ports.sessions.start).mockRejectedValueOnce(
        Object.assign(new Error('private body'), { code }),
      )
      const request = create()
      await f.service.submit(f.one, request)
      expect(f.last(request.requestId)).toMatchObject({
        status: 'failed',
        error: { message: 'the lane could not start' },
      })
    }
    // The folder sentence and the one token-shaped code.
    expect(f.logs.filter((l) => l.message === 'lane.command_error')).toHaveLength(2)
    expect(JSON.stringify(f.logs)).not.toContain('private')
  })
  it('maps a store capacity race to too-many-requests and stops the started session', async () => {
    vi.spyOn(f.store, 'ensureLane').mockImplementationOnce(() => {
      throw new LaneCapacityReached()
    })
    const request = create()
    await f.service.submit(f.one, request)
    expect(f.last(request.requestId)).toMatchObject({ code: 'too-many-requests' })
    expect(f.ports.sessions.stop).toHaveBeenCalledWith('new-session')
  })
  it('keeps same-branch creation serialized beyond the deadline until rollback settles', async () => {
    let owned = false
    const undo = vi.fn(async () => {
      expect(owned).toBe(true)
      owned = false
    })
    const folder = vi.spyOn(folders, 'prepareLaneFolder').mockImplementation(async () => {
      expect(owned).toBe(false)
      owned = true
      return { cwd: f.lane.cwd, branch: 'same', undo }
    })
    const gate = deferred<{ sessionId: string; sessionFile: null }>()
    const entered = deferred<void>()
    vi.mocked(f.ports.sessions.start).mockImplementationOnce(() => {
      entered.release()
      return gate.promise
    })
    const first = create({ worktree: { branch: 'same' } })
    const a = f.service.submit(f.one, first)
    await entered.promise
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    expect(f.last(first.requestId)?.status).toBe('unknown')
    const second = create({ worktree: { branch: 'same' } })
    const b = f.service.submit(f.two, second)
    await vi.advanceTimersByTimeAsync(0)
    expect(folder).toHaveBeenCalledTimes(1)
    expect(f.ports.sessions.start).toHaveBeenCalledTimes(1)
    gate.reject(new Error('start failed'))
    await Promise.all([a, b])
    expect(undo).toHaveBeenCalledTimes(1)
    expect(owned).toBe(true)
    expect(f.last(second.requestId)?.status).toBe('done')
    expect(f.receipts(first.requestId)).toHaveLength(1)
  })
  it('publishes and attaches a late success while keeping only the unknown receipt', async () => {
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
    const request = create()
    const running = f.service.submit(f.one, request)
    const laneId = await entered.promise
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    expect(f.receipts(request.requestId)).toEqual([
      { requestId: request.requestId, status: 'unknown' },
    ])
    expect(f.events).toEqual([])
    gate.release()
    await running
    expect(f.store.getLane(laneId)?.removedAt).toBeNull()
    expect(f.sessions.get(laneId)).toBe('new-session')
    expect(f.events.map(({ event }) => event.kind)).toEqual(['control', 'summary'])
    expect(f.events[0]?.event).toMatchObject({
      control: { fence: 1, controller: { clientId: f.one.id } },
    })
    expect(f.receipts(request.requestId)).toHaveLength(1)
  })
  it('holds the created lane queue during attach and publishes fence 1 before a queued take', async () => {
    vi.spyOn(folders, 'prepareLaneFolder').mockResolvedValue({
      cwd: f.lane.cwd,
      branch: null,
      undo: async () => {},
    })
    const gate = deferred<void>()
    const entered = deferred<string>()
    vi.mocked(f.ports.sessions.attach).mockImplementation(async (laneId) => {
      entered.release(laneId)
      await gate.promise
    })
    const request = create()
    const running = f.service.submit(f.one, request)
    const laneId = await entered.promise
    const take = f.frame({ type: 'control.take' }, 1, laneId)
    const queued = f.service.submit(f.two, take)
    expect(f.events).toEqual([])
    expect(f.store.getLane(laneId)?.control.fence).toBe(1)
    gate.release()
    await Promise.all([running, queued])
    expect(f.events.map(({ event }) => event.kind)).toEqual(['control', 'summary', 'control'])
    expect(f.events[0]?.event).toMatchObject({ control: { fence: 1 } })
    expect(f.events[2]?.event).toMatchObject({ control: { fence: 2 } })
    expect(f.last(request.requestId)).toMatchObject({ status: 'done', fence: 1 })
  })
  it('republishes failed initial control on the created lane queue before the next op', async () => {
    vi.spyOn(folders, 'prepareLaneFolder').mockResolvedValue({
      cwd: f.lane.cwd,
      branch: null,
      undo: async () => {},
    })
    const publish = f.ports.publish
    f.ports.publish = vi.fn(publish).mockImplementationOnce(() => {
      throw new Error('publish')
    })
    const request = create()
    await f.service.submit(f.one, request)
    const created = f.store.listLanes().find((entry) => entry.laneId !== f.lane.laneId)
    if (!created) throw new Error('missing lane')
    expect(f.last(request.requestId)).toMatchObject({
      status: 'done',
      laneId: created.laneId,
      fence: 1,
    })
    expect(f.ports.sessions.attach).toHaveBeenCalledWith(created.laneId, 'new-session')
    expect(f.ports.sessions.stop).not.toHaveBeenCalled()
    expect(f.receipts(request.requestId)).toHaveLength(1)
    const take = f.frame({ type: 'control.take' }, 1, created.laneId)
    await f.service.submit(f.two, take)
    expect(f.events.map(({ event }) => event.kind)).toEqual(['summary', 'control', 'control'])
    expect(f.events[1]?.event).toMatchObject({ control: { fence: 1 } })
    expect(f.events[2]?.event).toMatchObject({ control: { fence: 2 } })
  })
  it('keeps an attached lane and drains both queues after a throwing creation summary', async () => {
    vi.spyOn(folders, 'prepareLaneFolder').mockResolvedValue({
      cwd: f.lane.cwd,
      branch: null,
      undo: async () => {},
    })
    const gate = deferred<void>()
    const entered = deferred<string>()
    vi.mocked(f.ports.sessions.attach).mockImplementationOnce(async (laneId, sessionId) => {
      entered.release(laneId)
      await gate.promise
      f.sessions.set(laneId, sessionId)
    })
    const summary = f.ports.summaryFor
    f.ports.summaryFor = vi.fn(summary).mockImplementationOnce(() => {
      throw new Error('projection')
    })
    const request = create()
    const running = f.service.submit(f.one, request)
    const laneId = await entered.promise
    const take = f.frame({ type: 'control.take' }, 1, laneId)
    const queuedTake = f.service.submit(f.two, take)
    const next = create()
    const queuedCreate = f.service.submit(f.one, next)
    gate.release()
    await Promise.all([running, queuedTake, queuedCreate])
    expect(f.receipts(request.requestId)).toEqual([
      { requestId: request.requestId, status: 'unknown' },
    ])
    expect(f.store.getLane(laneId)?.removedAt).toBeNull()
    expect(f.sessions.get(laneId)).toBe('new-session')
    expect(f.ports.sessions.stop).not.toHaveBeenCalled()
    expect(f.last(take.requestId)).toMatchObject({ status: 'done', fence: 2 })
    expect(f.last(next.requestId)).toMatchObject({ status: 'done', fence: 1 })
  })
  it.each(['before-settle', 'after-settle'])(
    'holds an already draining lane queue through reused-session attachment (%s)',
    async (when) => {
      vi.spyOn(folders, 'prepareLaneFolder').mockResolvedValue({
        cwd: f.lane.cwd,
        branch: null,
        undo: async () => {},
      })
      vi.mocked(f.ports.sessions.start).mockResolvedValueOnce({
        sessionId: 'pi-live',
        sessionFile: f.lane.sessionFile,
      })
      const gate = deferred<void>()
      const entered = deferred<string>()
      vi.mocked(f.ports.sessions.attach).mockImplementationOnce(async (laneId) => {
        entered.release(laneId)
        await gate.promise
      })
      const stopped = deferred<void>()
      f.ports.stopLane = vi.fn(() => stopped.promise)
      const stopping = f.service.submit(f.one, f.frame({ type: 'lane.stop' }))
      const creating = f.service.submit(f.one, create())
      expect(await entered.promise).toBe(f.lane.laneId)
      const take = f.frame({ type: 'control.take' }, 2)
      let taking: Promise<void> | undefined
      if (when === 'before-settle') taking = f.service.submit(f.two, take)
      stopped.release()
      await stopping
      await vi.advanceTimersByTimeAsync(0)
      if (when === 'after-settle') taking = f.service.submit(f.two, take)
      expect(f.store.getLane(f.lane.laneId)?.control.fence).toBe(2)
      expect(f.last(take.requestId)).toBeUndefined()
      gate.release()
      await Promise.all([creating, taking])
      expect(f.last(take.requestId)).toMatchObject({ status: 'done', fence: 3 })
      expect(
        f.events
          .filter(({ event }) => event.kind === 'control')
          .map(({ event }) => (event.kind === 'control' ? event.control.fence : null)),
      ).toEqual([2, 2, 3])
    },
  )
  it('releases the created lane hold after failed attach and queued ops see unknown-lane', async () => {
    vi.spyOn(folders, 'prepareLaneFolder').mockResolvedValue({
      cwd: f.lane.cwd,
      branch: null,
      undo: async () => {},
    })
    const gate = deferred<void>()
    const entered = deferred<string>()
    vi.mocked(f.ports.sessions.attach).mockImplementation(async (laneId) => {
      entered.release(laneId)
      await gate.promise
    })
    const request = create()
    const running = f.service.submit(f.one, request)
    const laneId = await entered.promise
    const take = f.frame({ type: 'control.take' }, 1, laneId)
    const queued = f.service.submit(f.two, take)
    gate.reject(new Error('attach'))
    await Promise.all([running, queued])
    expect(f.events).toEqual([])
    expect(f.last(take.requestId)).toMatchObject({ status: 'rejected', code: 'unknown-lane' })
  })
  it('serializes two creates and reports unknown at the answer deadline without a late receipt', async () => {
    vi.spyOn(folders, 'prepareLaneFolder').mockResolvedValue({
      cwd: f.lane.cwd,
      branch: null,
      undo: async () => {},
    })
    const gate = deferred<{ sessionId: string; sessionFile: null }>()
    const entered = deferred<void>()
    vi.mocked(f.ports.sessions.start).mockImplementationOnce(() => {
      entered.release()
      return gate.promise
    })
    const first = create()
    const second = create()
    const a = f.service.submit(f.one, first)
    const b = f.service.submit(f.two, second)
    await entered.promise
    await vi.advanceTimersByTimeAsync(0)
    expect(f.ports.sessions.start).toHaveBeenCalledTimes(1)
    gate.release({ sessionId: 'first', sessionFile: null })
    await a
    await b
    expect(f.ports.sessions.start).toHaveBeenCalledTimes(2)
    const late = deferred<{ sessionId: string; sessionFile: null }>()
    const lateEntered = deferred<void>()
    vi.mocked(f.ports.sessions.start).mockImplementationOnce(() => {
      lateEntered.release()
      return late.promise
    })
    const request = create()
    const running = f.service.submit(f.one, request)
    await lateEntered.promise
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    expect(f.last(request.requestId)).toMatchObject({ status: 'unknown' })
    late.release({ sessionId: 'late', sessionFile: null })
    await running
    await vi.advanceTimersByTimeAsync(0)
    expect(f.receipts(request.requestId)).toHaveLength(1)
  })
})

describe('lane.create model admission and attachment cleanup', () => {
  const request = (
    fields: Partial<Extract<LaneOp, { type: 'lane.create' }>>,
  ): LaneCommandFrame => ({
    type: 'command',
    requestId: randomUUID(),
    op: { type: 'lane.create', repositoryId: f.lane.repositoryId, worktree: null, ...fields },
  })
  it.each([{ provider: 'provider' }, { model: 'model' }])(
    'starts a partial model selection without storing a partial pair: %j',
    async (fields) => {
      const create = request(fields)
      await f.service.submit(f.one, create)
      const receipt = f.last(create.requestId)
      if (receipt?.status !== 'done' || !receipt.laneId) throw new Error('missing created lane')
      expect(f.store.getLane(receipt.laneId)?.model).toBeNull()
      expect(f.ports.sessions.start).toHaveBeenCalledWith({
        repository: f.store.listRepositories()[0]?.path,
        ...('model' in fields ? { model: fields.model } : {}),
      })
    },
  )
  it('accepts both model fields at their exact limits, rejects one past either before folder or session work', async () => {
    const folder = vi.spyOn(folders, 'prepareLaneFolder')
    await f.service.submit(f.one, request({ provider: 'p'.repeat(64), model: 'm'.repeat(128) }))
    expect(f.ports.sessions.start).toHaveBeenCalledTimes(1)
    for (const fields of [{ provider: 'p'.repeat(65) }, { model: 'm'.repeat(129) }]) {
      const create = request(fields)
      await f.service.submit(f.one, create)
      expect(f.last(create.requestId)).toMatchObject({ status: 'rejected', code: 'bad-request' })
    }
    expect(folder).toHaveBeenCalledTimes(1)
    expect(f.ports.sessions.start).toHaveBeenCalledTimes(1)
  })
  it('removes a visible lane row after attachment failure and still stops its session', async () => {
    vi.mocked(f.ports.sessions.attach).mockRejectedValueOnce(new Error('private'))
    const create = request({})
    await f.service.submit(f.one, create)
    expect(f.last(create.requestId)).toMatchObject({
      status: 'failed',
      error: { message: 'the lane could not start' },
    })
    expect(f.store.listLanes()).toHaveLength(1)
    expect(f.ports.sessions.stop).toHaveBeenCalledWith('new-session')
    expect(f.events).toEqual([])
  })
})
