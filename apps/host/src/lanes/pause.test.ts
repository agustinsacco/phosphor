import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStore } from './store'
import { createLanePauses, type LanePausePorts, type PausableLane } from './pause'
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
