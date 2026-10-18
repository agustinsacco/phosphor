import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import * as folders from '../worktree'
import { LaneCapacityReached } from '../store'
import {
  createCommandsFixture,
  deferred,
  type CommandsFixture,
} from '../__fixtures__/commands.fixture'
import {
  creationFailure,
  executeCreate,
  holdCreatedLane,
  mapCreationReceipt,
  publishCreated,
  releaseCreatedLane,
  runCreation,
  validateCreate,
  type CreateOp,
  type Creation,
} from './create'
import { queueFor } from './queue'
import { createCommandState, type ExecuteJob, type Job } from './state'

let f: CommandsFixture
beforeEach(async () => {
  vi.useFakeTimers()
  f = await createCommandsFixture()
  vi.spyOn(folders, 'prepareLaneFolder').mockResolvedValue({
    cwd: f.lane.cwd,
    branch: null,
    undo: async () => {},
  })
})
afterEach(() => {
  f.cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const op = (overrides: Partial<CreateOp> = {}): CreateOp => ({
  type: 'lane.create',
  repositoryId: f.lane.repositoryId,
  worktree: null,
  ...overrides,
})
function job(create = op()): Job {
  return {
    client: f.one,
    frame: { type: 'command', requestId: randomUUID(), op: create },
    started: 0,
    resolve: vi.fn(),
  }
}
const noJobs: ExecuteJob = () => undefined
const errors = () => f.logs.filter((entry) => entry.message === 'lane.command_error')

describe('validateCreate', () => {
  it('refuses scope, unknown repositories and oversized or unnormalized fields', () => {
    for (const [laneId, create] of [
      [f.lane.laneId, op()],
      [undefined, op({ repositoryId: '0000000000000000' })],
      [undefined, op({ provider: 'p'.repeat(65) })],
      [undefined, op({ model: 'm'.repeat(129) })],
      [undefined, op({ name: 'n'.repeat(HOST_LIMITS.labelChars + 1) })],
      [undefined, op({ name: ' padded ' })],
    ] as const)
      expect(validateCreate(f.store, laneId, create)).toEqual({ ok: false, code: 'bad-request' })
    const exact = op({
      provider: 'p'.repeat(64),
      model: 'm'.repeat(128),
      name: 'n'.repeat(HOST_LIMITS.labelChars),
    })
    const root = f.store.listRepositories()[0]?.path
    expect(validateCreate(f.store, undefined, exact)).toEqual({ ok: true, root })
  })

  it('refuses at the lane cap after the field checks', () => {
    vi.spyOn(f.store, 'listLanes').mockReturnValue(
      Array.from({ length: f.store.limits.lanesPerHost }, () => f.lane),
    )
    expect(validateCreate(f.store, undefined, op())).toEqual({
      ok: false,
      code: 'too-many-requests',
    })
    expect(validateCreate(f.store, f.lane.laneId, op())).toEqual({ ok: false, code: 'bad-request' })
  })
})

describe('creationFailure', () => {
  it('classifies capacity, branch conflicts, folder messages and generic failures', () => {
    const requestId = randomUUID()
    expect(creationFailure(f.ports, requestId, new LaneCapacityReached())).toEqual({
      kind: 'capacity',
    })
    expect(
      creationFailure(f.ports, requestId, new folders.LaneFolderError('taken', 'branch-exists')),
    ).toEqual({ kind: 'branch-exists' })
    expect(
      creationFailure(f.ports, requestId, new folders.LaneFolderError('That name is not valid.')),
    ).toEqual({ kind: 'failed', error: { code: 'internal', message: 'That name is not valid.' } })
    expect(creationFailure(f.ports, requestId, 'private string')).toEqual({
      kind: 'failed',
      error: { code: 'internal', message: 'the lane could not start' },
    })
    expect(errors()).toEqual([])
  })

  it('logs only token-shaped error codes', () => {
    const requestId = randomUUID()
    for (const code of ['SAFE.code-1', 'bad code', 'x'.repeat(65), 7, null])
      creationFailure(f.ports, requestId, Object.assign(new Error('private body'), { code }))
    expect(errors()).toEqual([
      {
        message: 'lane.command_error',
        data: { requestId, op: 'lane.create', code: 'SAFE.code-1' },
      },
    ])
    expect(JSON.stringify(f.logs)).not.toContain('private')
  })
})

describe('created lane hold', () => {
  it('holds the lane queue and drains what queued behind it once released', async () => {
    const state = createCommandState()
    const creation: Creation = {}
    releaseCreatedLane(state, f.ports, noJobs, creation)
    holdCreatedLane(state, creation, f.lane.laneId)
    const queue = queueFor(state, f.lane.laneId)
    expect(creation.hold).toEqual({ laneId: f.lane.laneId, queue })
    expect(queue.holds).toBe(1)
    const waiting = job()
    queue.jobs.push(waiting)
    const execute = vi.fn<ExecuteJob>(() => undefined)
    releaseCreatedLane(state, f.ports, execute, creation)
    expect(queue.holds).toBe(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(execute).toHaveBeenCalledWith(waiting, queue)
    expect(waiting.resolve).toHaveBeenCalledTimes(1)
    expect(state.queues.has(f.lane.laneId)).toBe(false)
  })

  it('leaves an already draining queue to its own drain', () => {
    const state = createCommandState()
    const creation: Creation = {}
    holdCreatedLane(state, creation, f.lane.laneId)
    const queue = queueFor(state, f.lane.laneId)
    queue.draining = true
    queue.jobs.push(job())
    const execute = vi.fn<ExecuteJob>(() => undefined)
    releaseCreatedLane(state, f.ports, execute, creation)
    expect(queue.holds).toBe(0)
    expect(execute).not.toHaveBeenCalled()
  })

  it('publishes control fence 1 then the summary, and owes control when it fails', () => {
    const state = createCommandState()
    const queue = queueFor(state, f.lane.laneId)
    publishCreated(state, f.ports, f.lane, queue)
    expect(f.order).toEqual(['control', 'summary'])
    f.ports.summaryFor = () => null
    f.ports.publish = () => {
      throw new Error('stream failed')
    }
    publishCreated(state, f.ports, f.lane, queue)
    expect(queue.controlUnpublished).toBe(true)
    expect(f.order).toEqual(['control', 'summary'])
  })
})

describe('runCreation releases the hold on every path', () => {
  async function run(state = createCommandState()) {
    const creation: Creation = {}
    const execute = vi.fn<ExecuteJob>(() => undefined)
    const result = await runCreation(state, f.ports, job(), {
      op: op(),
      root: f.lane.cwd,
      creation,
      execute,
    })
    return { result, creation, state }
  }
  const holds = (state: ReturnType<typeof createCommandState>, laneId?: string) =>
    laneId === undefined ? 0 : (state.queues.get(laneId)?.holds ?? 0)

  it('stores, publishes and releases a created lane', async () => {
    const { result, creation, state } = await run()
    if (result.kind !== 'created') throw new Error('expected a created lane')
    expect(creation.hold?.laneId).toBe(result.lane.laneId)
    expect(holds(state, result.lane.laneId)).toBe(0)
    expect(f.events.map(({ laneId, event }) => [laneId, event.kind])).toEqual([
      [result.lane.laneId, 'control'],
      [result.lane.laneId, 'summary'],
    ])
  })

  it('never holds when the start or the store fails before a row exists', async () => {
    vi.mocked(f.ports.sessions.start).mockRejectedValueOnce(new Error('start failed'))
    const started = await run()
    expect(started.result).toMatchObject({ kind: 'failed' })
    expect(started.creation.hold).toBeUndefined()
    vi.spyOn(f.store, 'ensureLane').mockImplementationOnce(() => {
      throw new LaneCapacityReached()
    })
    const capacity = await run()
    expect(capacity.result).toEqual({ kind: 'capacity' })
    expect(capacity.creation.hold).toBeUndefined()
  })

  it('releases after a stored lane fails to attach, or after close', async () => {
    vi.mocked(f.ports.sessions.attach).mockRejectedValueOnce(new Error('attach failed'))
    const failed = await run()
    expect(failed.result).toMatchObject({ kind: 'failed' })
    expect(holds(failed.state, failed.creation.hold?.laneId)).toBe(0)
    const state = createCommandState()
    vi.mocked(f.ports.sessions.attach).mockImplementationOnce(async () => {
      state.closed = true
    })
    const closed = await run(state)
    expect(closed.result).toEqual({ kind: 'closed' })
    expect(closed.creation.hold).toBeDefined()
    expect(f.events).toEqual([])
  })
})

describe('mapCreationReceipt', () => {
  it('records each outcome once, and throws for a closed creation', () => {
    const state = createCommandState()
    const cases = [
      [{ answered: false, reason: 'deadline' }, { status: 'unknown' }],
      [{ answered: true, value: { kind: 'capacity' } }, { code: 'too-many-requests' }],
      [{ answered: true, value: { kind: 'branch-exists' } }, { code: 'branch-exists' }],
      [
        {
          answered: true,
          value: { kind: 'failed', error: { code: 'internal', message: 'm' } },
        },
        { status: 'failed', error: { code: 'internal', message: 'm' } },
      ],
      [
        { answered: true, value: { kind: 'created', lane: f.lane } },
        { status: 'done', laneId: f.lane.laneId, fence: 1 },
      ],
    ] as const
    for (const [answer, receipt] of cases) {
      const current = job()
      mapCreationReceipt(state, f.ports, current, answer)
      expect(f.last(current.frame.requestId)).toMatchObject(receipt)
    }
    // Never begun in the store, so each finish is unrecorded but still delivered.
    expect(f.logs.find((entry) => entry.message === 'lane.command')).toMatchObject({
      data: { status: 'unknown', reason: 'deadline' },
    })
    expect(() =>
      mapCreationReceipt(state, f.ports, job(), { answered: true, value: { kind: 'closed' } }),
    ).toThrow('missing lane')
  })
})

describe('executeCreate', () => {
  it('refuses invalid input synchronously, before any folder or session work', () => {
    const state = createCommandState()
    const create = op({ repositoryId: '0000000000000000' })
    const current = job(create)
    const queue = queueFor(state, '')
    expect(
      executeCreate(state, f.ports, current, queue, {
        op: create,
        execute: noJobs,
      }),
    ).toBeUndefined()
    expect(f.last(current.frame.requestId)).toMatchObject({ code: 'bad-request' })
    expect(folders.prepareLaneFolder).not.toHaveBeenCalled()
    expect(queue.outstanding).toBe(0)
  })

  it('answers unknown at the deadline but completes only when the late success has published', async () => {
    const state = createCommandState()
    const attached = deferred<void>()
    vi.mocked(f.ports.sessions.attach).mockImplementationOnce(() => attached.promise)
    const create = op()
    const current = job(create)
    const queue = queueFor(state, '')
    const execution = executeCreate(state, f.ports, current, queue, {
      op: create,
      execute: noJobs,
    })
    if (!execution) throw new Error('expected an execution')
    expect(execution.detached).toBe(false)
    let completed = false
    void execution.completion.then(() => (completed = true))
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    expect(f.last(current.frame.requestId)).toEqual({
      requestId: current.frame.requestId,
      status: 'unknown',
    })
    expect(completed).toBe(false)
    expect(queue.outstanding).toBe(1)
    attached.release()
    await execution.completion
    expect(f.order).toEqual(['control', 'summary'])
    expect(f.receipts(current.frame.requestId)).toHaveLength(1)
    expect(queue.outstanding).toBe(0)
  })
})
