import { describe, expect, it } from 'vitest'
import type { HostConnectionView } from '@shared/ipc'
import { observeResult, readUpdateStatus } from './machineUpdateFacts'
import { softwareUpdateLines } from './softwareUpdateText'
import {
  deriveMachineUpdate,
  holdUpdatePage,
  observeConnection,
  observePause,
  reach,
  startRun,
  tickRun,
  type MachineUpdateEntry,
  type UpdateRun,
  type Waiting,
} from './machineUpdateState'

const host: HostConnectionView = {
  state: 'ready',
  hostVersion: '1.2.3',
  connectionToken: '1',
  ops: true,
  capabilities: ['sessions.control', 'terminal'],
  repositories: [],
  lanes: [],
  cursor: { epoch: 'first', seq: 0 },
}
const MIN = 60_000

/** Walk a finished run through its remaining steps, 600 ms each. */
function settle(run: UpdateRun, from: number): UpdateRun {
  let at = from
  while (!run.settled && at < from + 10_000) run = tickRun(run, (at += 600))
  return run
}

function lines(entry: MachineUpdateEntry, now: number, at = host): string[] {
  return softwareUpdateLines(
    deriveMachineUpdate({
      machineId: 'm',
      label: 'Studio',
      host: at,
      entry,
      peers: [],
      configure: true,
      terminal: true,
      owner: true,
      now,
    }),
  )
}

function waitingFor(capMs: number | null): Waiting {
  const since = '2026-11-27T10:00:00.000Z'
  return {
    kind: 'pausing',
    purpose: 'update',
    since,
    deadline: capMs === null ? 'later' : new Date(Date.parse(since) + capMs).toISOString(),
    waitingOn: { turns: 1, subagents: 0, routines: 0 },
  }
}

describe('a wait for working lanes', () => {
  it.each([
    ['the pause cap', 10 * MIN],
    ['30 minutes without a usable cap', null],
  ])('ends at %s as still working, even while the Host is away', (_name, capMs) => {
    const pause = waitingFor(capMs)
    const limit = capMs ?? 30 * MIN
    let run = observePause({ ...startRun('op', {}, host, 0), jobId: 'job' }, pause, 1000)
    run = observeConnection(run, { status: { pause } }, undefined, 2000)
    expect(holdUpdatePage(run)).toBe(true)
    expect(tickRun(run, 1000 + limit - 1).finish).toBeUndefined()
    const ended = tickRun(run, 1000 + limit)
    expect(ended).toMatchObject({ finish: 'still-working', settled: true })
    expect(holdUpdatePage(ended)).toBe(false)
    // A visible result, and Update… again to retry (Stop turns forces it while waiting).
    const entry = { run: ended }
    expect(lines(entry, 1000 + limit)).toContain('Lanes were still working. Nothing changed.')
    expect(
      deriveMachineUpdate({
        machineId: 'm',
        label: 'Studio',
        host,
        entry,
        peers: [],
        configure: true,
        terminal: true,
        owner: true,
      }).can.start,
    ).toBe(true)
  })
})

describe('a Host that comes back as a new instance mid-update', () => {
  const applying = (): UpdateRun => ({
    ...reach({ ...startRun('op', {}, host, 0), to: '1.3.0' }, 'restarting', 10),
    wentOffline: true,
  })
  const back = { ...host, cursor: { epoch: 'next', seq: 0 } }

  it('says it restarted without finishing, not that it rolled back', () => {
    const run = observeConnection(applying(), {}, back, 20)
    expect(run.finish).toBe('restarted')
    const settled = settle(run, 20)
    const text = lines({ run: settled }, 1000).join(' ')
    expect(text).toContain('Studio restarted')
    expect(text).toContain('didn’t finish')
    expect(text).not.toContain('health check')
  })

  it('says rolled back once the update result says so', () => {
    const run = settle(observeConnection(applying(), {}, back, 20), 20)
    const last = {
      from: '1.2.3',
      to: '1.3.0',
      outcome: 'rolled-back',
      at: '2026-11-27T10:00:00.000Z',
    } as const
    const entry = observeResult({ run, last }, 2000)
    expect(entry.run?.finish).toBe('rolled-back')
    expect(lines(entry, 2000).join(' ')).toContain('health check')
  })
})

describe('how a wait ended, in a window with no job', () => {
  const pause = waitingFor(10 * MIN)
  const watching = () => observePause(startRun('op', {}, host, 0), pause, 1)

  it.each([
    ['cancelled', 'cancelled'],
    ['deadline', 'still-working'],
    ['someday', 'still-working'],
    [undefined, 'still-working'],
  ])('reads ended %s as %s', (ended, finish) => {
    const status = readUpdateStatus({ pause: { kind: 'none', ended } })
    expect(status?.pause).toEqual(
      ended === 'cancelled' || ended === 'deadline' ? { kind: 'none', ended } : { kind: 'none' },
    )
    expect(observePause(watching(), status?.pause, 2).finish).toBe(finish)
  })
})

describe('a slow restart', () => {
  const restarting = (): UpdateRun => ({
    ...reach(startRun('op', {}, host, 0), 'restarting', 0),
    step: 'restarting',
    wentOffline: true,
  })

  it('still says restarting after 4 minutes, and rolls back on its own', () => {
    const run = tickRun(restarting(), 4 * MIN)
    expect(run.finish).toBeUndefined()
    expect(lines({ run }, 4 * MIN, { ...host, state: 'reconnecting' }).join(' ')).toBe(
      'Still restarting… a failed update rolls back on its own.',
    )
    expect(
      lines({ run: tickRun(restarting(), 4 * MIN - 1) }, 0, {
        ...host,
        state: 'reconnecting',
      }).join(' '),
    ).toContain('This usually takes under a minute.')
  })

  it('is not back only after 6 minutes', () => {
    expect(tickRun(restarting(), 6 * MIN - 1).finish).toBeUndefined()
    const run = tickRun(restarting(), 6 * MIN)
    expect(run).toMatchObject({ finish: 'not-back', settled: true })
    expect(lines({ run }, 6 * MIN, { ...host, state: 'reconnecting' }).join(' ')).toContain(
      'after 6 minutes',
    )
  })
})
