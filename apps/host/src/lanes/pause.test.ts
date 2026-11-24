import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHostFrame, type LaneOp } from '@phosphor/shared/host-protocol'
import { createLiveLanes } from './live'
import { openStore } from './store'
import { answerPauseCall, createLanePauses, type LanePausePorts, type PausableLane } from './pause'
import { createCommandsFixture, type CommandsFixture } from './__fixtures__/commands.fixture'

let f: CommandsFixture
beforeEach(async () => {
  f = await createCommandsFixture()
})
afterEach(() => {
  f.cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setup(lanes: () => PausableLane[], ports: Partial<LanePausePorts> = {}) {
  const changed: string[][] = []
  const pauses = createLanePauses({
    rows: f.store.pauses,
    liveLanes: lanes,
    runningRoutines: () => 0,
    abortTurns: vi.fn(async () => []),
    changed: (laneIds) => changed.push([...laneIds]),
    resumed: vi.fn(),
    now: () => Date.now(),
    log: vi.fn(),
    pollMs: 5,
    ...ports,
  })
  return { pauses, changed }
}

describe('service pause, R6', () => {
  it('rejects a prompt busy, lets the turn in flight finish, and keeps the row across a reopen', async () => {
    let working = true
    const { pauses } = setup(() => [{ laneId: f.lane.laneId, sessionId: 'pi-live', working }])
    f.ports.pauses = pauses
    const first = f.frame()
    const running = f.service.submit(f.one, first)
    await vi.waitFor(() => expect(f.pending).toHaveLength(1))
    const outcome = pauses.begin('update')
    expect(pauses.state()).toMatchObject({
      kind: 'pausing',
      purpose: 'update',
      waitingOn: { turns: 1, subagents: 0, routines: 0 },
    })
    const later = f.frame({ type: 'prompt', message: 'later' }, 2)
    const refused = f.service.submit(f.one, later)
    f.finish(0)
    await running
    await refused
    expect(f.last(first.requestId)).toMatchObject({ status: 'done' })
    expect(f.last(later.requestId)).toMatchObject({ status: 'rejected', code: 'busy' })
    expect(f.command).toHaveBeenCalledTimes(1)
    working = false
    expect(await outcome).toBe('paused')
    expect(pauses.state()).toMatchObject({ kind: 'paused', purpose: 'update' })
    expect(f.store.pauses.list()).toEqual([
      { laneId: f.lane.laneId, pausedAt: expect.any(Number), was: 'idle' },
    ])
    pauses.close()
    f.store.close()
    f.store = await openStore(join(f.root, 'state'), process.getuid?.())
    expect(f.store.pauses.list()).toEqual([
      { laneId: f.lane.laneId, pausedAt: expect.any(Number), was: 'idle' },
    ])
  })
})

describe('service pause limits', () => {
  it('cancels at the limit and never aborts a turn', async () => {
    vi.useFakeTimers()
    const abortTurns = vi.fn(async () => ['pi-live'])
    const log = vi.fn()
    const { pauses } = setup(
      () => [{ laneId: f.lane.laneId, sessionId: 'pi-live', working: true }],
      {
        abortTurns,
        log,
      },
    )
    const outcome = pauses.begin('update', 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await outcome).toBe('deadline')
    expect(abortTurns).not.toHaveBeenCalled()
    expect(pauses.state()).toEqual({ kind: 'none' })
    expect(pauses.admits({ type: 'prompt' })).toBe(true)
    expect(f.store.pauses.list()).toEqual([])
    expect(log).toHaveBeenCalledWith('pause.deadline', { turns: 1, subagents: 0, routines: 0 })
  })

  it('cancels a pause nobody applied at the same limit, logged once, and deletes its rows', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const resumed = vi.fn()
    const { pauses } = setup(
      () => [{ laneId: f.lane.laneId, sessionId: 'pi-live', working: false }],
      {
        log,
        resumed,
      },
    )
    expect(await pauses.begin('update', 60_000)).toBe('paused')
    expect(f.store.pauses.list()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(pauses.state()).toMatchObject({ kind: 'paused' })
    await vi.advanceTimersByTimeAsync(1)
    expect(pauses.state()).toEqual({ kind: 'none' })
    expect(f.store.pauses.list()).toEqual([])
    expect(resumed).toHaveBeenCalledTimes(1)
    expect(log.mock.calls.filter(([event]) => event === 'pause.expired')).toEqual([
      ['pause.expired', { limitMs: 60_000 }],
    ])
  })

  it('caps a longer deadline at ten minutes', () => {
    vi.useFakeTimers({ now: 0 })
    const { pauses } = setup(() => [{ laneId: f.lane.laneId, sessionId: 'pi-live', working: true }])
    void pauses.begin('update', 3_600_000)
    expect(pauses.state()).toMatchObject({
      kind: 'pausing',
      deadline: new Date(600_000).toISOString(),
    })
    pauses.close()
  })
})

describe('service pause waits and Abort now', () => {
  it('waits for reported sub-agents and running routines, not only turns', async () => {
    let routines = 1
    const { pauses } = setup(
      () => [{ laneId: f.lane.laneId, sessionId: 'pi-live', working: false }],
      {
        runningRoutines: () => routines,
      },
    )
    pauses.liveness('pi-live', 2)
    pauses.liveness('gone', 5)
    const outcome = pauses.begin('update')
    expect(pauses.state()).toMatchObject({ waitingOn: { turns: 0, subagents: 2, routines: 1 } })
    routines = 0
    pauses.liveness('pi-live', 0)
    expect(await outcome).toBe('paused')
  })

  it('aborts and saves the turns in flight only on Abort now, and records them aborted', async () => {
    const abortTurns = vi.fn(async () => ['pi-live'])
    const { pauses } = setup(
      () => [{ laneId: f.lane.laneId, sessionId: 'pi-live', working: true }],
      {
        abortTurns,
      },
    )
    const outcome = pauses.begin('update')
    expect(await pauses.abortNow()).toMatchObject({ kind: 'paused' })
    expect(await outcome).toBe('paused')
    expect(abortTurns).toHaveBeenCalledTimes(1)
    expect(f.store.pauses.list()).toEqual([
      { laneId: f.lane.laneId, pausedAt: expect.any(Number), was: 'aborted' },
    ])
    pauses.close()
  })

  it('does nothing on Abort now unless pausing', async () => {
    const abortTurns = vi.fn(async () => [])
    const { pauses } = setup(() => [], { abortTurns })
    expect(await pauses.abortNow()).toEqual({ kind: 'none' })
    expect(abortTurns).not.toHaveBeenCalled()
  })

  it('answers cancel while pausing, and a second begin joins the first', async () => {
    const { pauses, changed } = setup(() => [
      { laneId: f.lane.laneId, sessionId: 'pi-live', working: true },
    ])
    const first = pauses.begin('update')
    expect(pauses.begin('update')).toBe(first)
    expect(pauses.pauseFor(f.lane.laneId)).toEqual({
      reason: 'service-update',
      at: expect.any(String),
    })
    pauses.cancel()
    expect(await first).toBe('cancelled')
    expect(pauses.pauseFor(f.lane.laneId)).toBeUndefined()
    expect(changed).toEqual([[f.lane.laneId], [f.lane.laneId]])
  })
})

describe('service pause admission and Continue', () => {
  const live = () => [{ laneId: f.lane.laneId, sessionId: 'pi-live', working: true }]

  it.each([
    ['prompt', { type: 'prompt', message: 'm' }],
    ['steer', { type: 'steer', message: 'm' }],
    ['follow_up', { type: 'follow_up', message: 'm' }],
    ['lane.resume', { type: 'lane.resume' }],
  ] as const)('rejects %s on a lane busy while pausing', async (_name, op) => {
    const { pauses } = setup(live)
    f.ports.pauses = pauses
    void pauses.begin('update')
    const frame = f.frame(op)
    await f.service.submit(f.one, frame)
    expect(f.last(frame.requestId)).toEqual({
      requestId: frame.requestId,
      status: 'rejected',
      code: 'busy',
    })
    expect(f.command).not.toHaveBeenCalled()
    pauses.close()
  })

  it.each([
    ['lane.create', { type: 'lane.create', repositoryId: 'r', worktree: null }],
    ['routine.run', { type: 'routine.run', routineId: '00000000-0000-4000-8000-000000000000' }],
  ] satisfies [string, LaneOp][])('rejects laneless %s busy while pausing', async (_name, op) => {
    const { pauses } = setup(live)
    f.ports.pauses = pauses
    void pauses.begin('update')
    const frame = { type: 'command' as const, requestId: crypto.randomUUID(), op }
    await f.service.submit(
      { ...f.one, caps: ['sessions.control', 'workspaces.write', 'routines'] },
      frame,
    )
    expect(f.last(frame.requestId)).toEqual({
      requestId: frame.requestId,
      status: 'rejected',
      code: 'busy',
    })
    pauses.close()
  })

  it('still admits an abort and a dialog reply while pausing', () => {
    const { pauses } = setup(live)
    void pauses.begin('update')
    for (const type of ['abort', 'extension_ui_response', 'lane.stop', 'control.take'])
      expect(pauses.admits({ type })).toBe(true)
    pauses.close()
  })

  it('ends a stored pause on an admitted prompt after the restart, not on a refused one', async () => {
    f.store.pauses.record([{ laneId: f.lane.laneId, pausedAt: 1000, was: 'idle' }])
    const { pauses, changed } = setup(() => [])
    f.ports.pauses = pauses
    expect(pauses.pauseFor(f.lane.laneId)).toEqual({
      reason: 'service-update',
      at: new Date(1000).toISOString(),
    })
    pauses.continued(f.lane.laneId, { type: 'set_model' })
    expect(f.store.pauses.list()).toHaveLength(1)
    const frame = f.frame()
    const running = f.service.submit(f.one, frame)
    await vi.waitFor(() => expect(f.pending).toHaveLength(1))
    f.finish(0)
    await running
    expect(f.store.pauses.list()).toEqual([])
    expect(pauses.pauseFor(f.lane.laneId)).toBeUndefined()
    expect(changed).toEqual([[f.lane.laneId]])
  })
})

describe('service pause on the wire', () => {
  // The frozen 684cb3478 parser drops it: libs/shared base-684cb3478.compatibility.test.ts.
  it("puts the lane's pause on its summary, which today's parser keeps", async () => {
    const { pauses } = setup(() => [{ laneId: f.lane.laneId, sessionId: 'pi-live', working: true }])
    const live = createLiveLanes({
      epoch: '0123456789abcdef',
      store: f.store,
      runtime: { command: vi.fn() },
      now: () => Date.now(),
      log: vi.fn(),
      pauseFor: (laneId) => pauses.pauseFor(laneId),
    })
    expect(live.summaryFor(f.lane.laneId)).not.toHaveProperty('pause')
    void pauses.begin('update')
    const summary = live.summaryFor(f.lane.laneId)
    expect(summary?.pause).toEqual({ reason: 'service-update', at: expect.any(String) })
    const frame = { type: 'lanes-delta', id: 'd', cursor: { epoch: '0123456789abcdef', seq: 1 } }
    const parsed = parseHostFrame(JSON.stringify({ ...frame, upsert: [summary], remove: [] }))
    expect(parsed).toMatchObject({ ok: true, value: { upsert: [summary] } })
    pauses.close()
  })

  it('answers machine.pause at once and follows begin, abort-now and cancel', async () => {
    const log = vi.fn()
    expect(answerPauseCall(null, { action: 'cancel' }, log)).toEqual({ kind: 'none' })
    expect(answerPauseCall(null, { action: 'begin', purpose: 'update' }, log)).toBeNull()
    let working = true
    const { pauses } = setup(() => [{ laneId: f.lane.laneId, sessionId: 'pi-live', working }])
    expect(answerPauseCall(pauses, { action: 'begin', purpose: 'update' }, log)).toMatchObject({
      kind: 'pausing',
      waitingOn: { turns: 1 },
    })
    expect(answerPauseCall(pauses, { action: 'cancel' }, log)).toEqual({ kind: 'none' })
    answerPauseCall(pauses, { action: 'begin', purpose: 'update', deadlineMs: 5000 }, log)
    answerPauseCall(pauses, { action: 'abort-now' }, log)
    await vi.waitFor(() => expect(pauses.state()).toMatchObject({ kind: 'paused' }))
    working = false
    pauses.close()
  })
})
