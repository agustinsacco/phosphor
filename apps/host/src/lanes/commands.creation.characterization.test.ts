import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type LaneOp } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import * as folders from './worktree'
import { LaneCapacityReached } from './store'
import { createLaneCommands, type LaneCommandClient, type LaneCommandFrame } from './commands'
import {
  createCommandsFixture,
  deferred,
  type CommandsFixture,
} from './__fixtures__/commands.fixture'

// Characterizes lane.create orchestration through createLaneCommands before HA-10
// moves it: the machine queue, the created lane's hold, receipts and cleanup.

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

const create = (overrides: Partial<Extract<LaneOp, { type: 'lane.create' }>> = {}) =>
  ({
    type: 'command',
    requestId: randomUUID(),
    op: { type: 'lane.create', repositoryId: f.lane.repositoryId, worktree: null, ...overrides },
  }) satisfies LaneCommandFrame
const routines: readonly HostCapability[] = ['routines', 'sessions.control']
const folder = (undo: () => Promise<void> = async () => {}) =>
  vi.spyOn(folders, 'prepareLaneFolder').mockResolvedValue({ cwd: f.lane.cwd, branch: null, undo })
const created = () => f.store.listLanes().find((lane) => lane.laneId !== f.lane.laneId)

describe('a timed-out creation keeps the machine queue', () => {
  it('until its start failure and folder rollback settle, counting its slot meanwhile', async () => {
    f.service = createLaneCommands(f.ports, { queueLimit: 2 })
    const order: string[] = []
    const undone = deferred<void>()
    folder(async () => {
      order.push('undo')
      await undone.promise
      order.push('undone')
    })
    const start = deferred<{ sessionId: string; sessionFile: null }>()
    vi.mocked(f.ports.sessions.start).mockImplementationOnce(() => start.promise)
    const routine = vi.fn(async () => {
      order.push('routine')
      return null
    })
    f.ports.routines = { execute: routine }
    const client: LaneCommandClient = { ...f.one, caps: routines }
    const request = create()
    const creating = f.service.submit(client, request)
    const queued = f.service.submit(client, {
      type: 'command',
      requestId: randomUUID(),
      op: { type: 'routine.pauseAll' },
    })
    let settled = false
    void creating.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    expect(f.last(request.requestId)).toEqual({ requestId: request.requestId, status: 'unknown' })
    // The submission resolves with the creation's work, not with its receipt.
    expect(settled).toBe(false)
    expect(f.logs).toContainEqual({
      message: 'lane.command',
      data: expect.objectContaining({ requestId: request.requestId, reason: 'deadline' }),
    })
    const busy = {
      type: 'command' as const,
      requestId: randomUUID(),
      op: { type: 'routine.pauseAll' as const },
    }
    await f.service.submit(client, busy)
    expect(f.last(busy.requestId)).toMatchObject({ status: 'rejected', code: 'busy' })
    start.reject(new Error('start failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['undo'])
    expect(settled).toBe(false)
    undone.release()
    await Promise.all([creating, queued])
    expect(order).toEqual(['undo', 'undone', 'routine'])
    expect(f.receipts(request.requestId)).toHaveLength(1)
    expect(f.logs.filter((entry) => entry.message === 'lane.command_late')).toHaveLength(1)
  })
})

describe('the created lane hold', () => {
  it('keeps a takeover queued through a late attachment, behind control fence 1 and the summary', async () => {
    folder()
    const attached = deferred<void>()
    const entered = deferred<string>()
    vi.mocked(f.ports.sessions.attach).mockImplementationOnce(async (laneId) => {
      entered.release(laneId)
      await attached.promise
    })
    const request = create()
    const creating = f.service.submit(f.one, request)
    const laneId = await entered.promise
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    expect(f.last(request.requestId)?.status).toBe('unknown')
    const take = f.frame({ type: 'control.take' }, 1, laneId)
    const taking = f.service.submit(f.two, take)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.last(take.requestId)).toBeUndefined()
    expect(f.events).toEqual([])
    attached.release()
    await Promise.all([creating, taking])
    expect(f.events.map(({ event }) => event)).toEqual([
      { kind: 'control', control: expect.objectContaining({ fence: 1 }) },
      { kind: 'summary', summary: expect.objectContaining({ laneId }) },
      { kind: 'control', control: expect.objectContaining({ fence: 2 }) },
    ])
    expect(f.last(take.requestId)).toMatchObject({ status: 'done', fence: 2 })
    expect(f.receipts(request.requestId)).toHaveLength(1)
  })

  it('republishes a failed fence 1 publication before the queued takeover runs', async () => {
    folder()
    const attached = deferred<void>()
    const entered = deferred<string>()
    vi.mocked(f.ports.sessions.attach).mockImplementationOnce(async (laneId) => {
      entered.release(laneId)
      await attached.promise
    })
    const publish = f.ports.publish
    f.ports.publish = vi.fn(publish).mockImplementationOnce(() => {
      throw new Error('stream failed')
    })
    const request = create()
    const creating = f.service.submit(f.one, request)
    const laneId = await entered.promise
    const take = f.frame({ type: 'control.take' }, 1, laneId)
    const taking = f.service.submit(f.two, take)
    attached.release()
    await Promise.all([creating, taking])
    expect(f.last(request.requestId)).toEqual({
      requestId: request.requestId,
      status: 'done',
      laneId,
      fence: 1,
    })
    expect(
      f.events.map(({ event }) => (event.kind === 'control' ? event.control.fence : event.kind)),
    ).toEqual(['summary', 1, 2])
    expect(f.last(take.requestId)).toMatchObject({ status: 'done', fence: 2 })
  })
})

describe('creation refusals and failures keep their receipts and cleanup', () => {
  it('refuses the lane cap before folder or session work', async () => {
    const prepare = folder()
    vi.spyOn(f.store, 'listLanes').mockReturnValue(
      Array.from({ length: f.store.limits.lanesPerHost }, () => f.lane),
    )
    const request = create()
    await f.service.submit(f.one, request)
    expect(f.store.getReceipt(request.requestId, f.one.id)).toEqual({
      requestId: request.requestId,
      status: 'rejected',
      code: 'too-many-requests',
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(f.ports.sessions.start).not.toHaveBeenCalled()
  })

  it('maps a store capacity race to too-many-requests after stopping and undoing', async () => {
    const undo = vi.fn(async () => {})
    folder(undo)
    vi.spyOn(f.store, 'ensureLane').mockImplementationOnce(() => {
      throw new LaneCapacityReached()
    })
    const request = create()
    await f.service.submit(f.one, request)
    expect(f.store.getReceipt(request.requestId, f.one.id)).toMatchObject({
      status: 'rejected',
      code: 'too-many-requests',
    })
    expect(f.ports.sessions.stop).toHaveBeenCalledWith('new-session')
    expect(undo).toHaveBeenCalledTimes(1)
    expect(created()).toBeUndefined()
    expect(f.events).toEqual([])
  })

  it('answers an existing branch as branch-exists without starting a session', async () => {
    vi.spyOn(folders, 'prepareLaneFolder').mockRejectedValueOnce(
      new folders.LaneFolderError('That branch already exists.', 'branch-exists'),
    )
    const request = create({ worktree: { branch: 'taken', fresh: true } })
    await f.service.submit(f.one, request)
    expect(f.last(request.requestId)).toEqual({
      requestId: request.requestId,
      status: 'rejected',
      code: 'branch-exists',
    })
    expect(f.ports.sessions.start).not.toHaveBeenCalled()
    expect(f.logs.filter((entry) => entry.message === 'lane.command_error')).toEqual([])
  })

  it('fails an attachment with the fixed start message, removes the row and refuses queued lane work', async () => {
    const undo = vi.fn(async () => {})
    folder(undo)
    const attached = deferred<void>()
    const entered = deferred<string>()
    vi.mocked(f.ports.sessions.attach).mockImplementationOnce(async (laneId) => {
      entered.release(laneId)
      await attached.promise
    })
    const request = create()
    const creating = f.service.submit(f.one, request)
    const laneId = await entered.promise
    const prompt = f.frame(undefined, 1, laneId)
    const queued = f.service.submit(f.two, prompt)
    attached.reject(Object.assign(new Error('private attach'), { code: 'ATTACH_FAILED' }))
    await Promise.all([creating, queued])
    expect(f.store.getReceipt(request.requestId, f.one.id)).toEqual({
      requestId: request.requestId,
      status: 'failed',
      error: { code: 'internal', message: 'the lane could not start' },
    })
    expect(f.store.getLane(laneId)?.removedAt).not.toBeNull()
    expect(f.ports.sessions.stop).toHaveBeenCalledWith('new-session')
    expect(undo).toHaveBeenCalledTimes(1)
    expect(f.last(prompt.requestId)).toMatchObject({ status: 'rejected', code: 'unknown-lane' })
    expect(f.logs).toContainEqual({
      message: 'lane.command_error',
      data: { requestId: request.requestId, op: 'lane.create', code: 'ATTACH_FAILED' },
    })
    expect(f.events).toEqual([])
    expect(JSON.stringify(f.logs)).not.toContain('private attach')
  })
})
