import { expect, it } from 'vitest'
import type { HostConnectionView } from '@shared/ipc'
import { readUpdateJob, readUpdateStatus } from './machineUpdateFacts'
import {
  deriveMachineUpdate,
  holdUpdatePage,
  nextRun,
  observeConnection,
  observePause,
  startRun,
  tickRun,
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
const waiting: Waiting = {
  kind: 'pausing',
  purpose: 'update',
  since: 'now',
  deadline: 'later',
  waitingOn: { turns: 2, subagents: 0, routines: 1 },
}
const paused = { kind: 'paused', purpose: 'update', since: 'now' } as const

it('holds each reached step for 600ms and ignores reconnect flaps to the same process', () => {
  let run = startRun('op', {}, host, 0)
  run = observePause(run, waiting, 1)
  expect(nextRun(run, 599).step).toBe('downloading')
  run = nextRun(run, 600)
  expect(run.step).toBe('waiting')
  run = observePause(run, paused, 601)
  run = observeConnection(run, {}, { ...host, state: 'reconnecting' }, 602)
  run = observeConnection(run, {}, { ...host, connectionToken: '2' }, 603)
  expect(run.reached).toBe('paused')
  expect(run.restartAt).toBeUndefined()
  run = nextRun(run, 1200)
  expect(run.step).toBe('paused')
  run = observeConnection(
    run,
    {},
    { ...host, hostVersion: '2.0.0', cursor: { epoch: 'next', seq: 0 } },
    1201,
  )
  expect(nextRun(run, 1799).step).toBe('paused')
  run = nextRun(run, 1800)
  expect(run.step).toBe('restarting')
  run = nextRun(run, 2400)
  expect(run).toMatchObject({ step: 'health', finish: 'updated', to: '2.0.0' })
  expect(nextRun(run, 3000).settled).toBe(true)
})

it('recognizes a replacement runtime when its cursor arrives after the ready snapshot', () => {
  const started = { ...startRun('op', {}, host, 0), jobId: 'update' }
  const offline = observeConnection(started, {}, undefined, 1)
  expect(holdUpdatePage(offline)).toBe(true)
  expect(offline.restartAt).toBeUndefined()
  expect(offline.wentOffline).toBeUndefined()
  const ready = observeConnection(offline, {}, { ...host, connectionToken: '2' }, 2)
  expect(holdUpdatePage(ready)).toBe(false)
  const replaced = observeConnection(ready, {}, { ...host, cursor: { epoch: 'next', seq: 0 } }, 3)
  expect(replaced).toMatchObject({ reached: 'health', finish: 'rolled-back', restartAt: 3 })
})

it('soft-times out and recovers on a new runtime running the original version', () => {
  const started = startRun('task', {}, host, 0)
  const offline = observeConnection(started, {}, undefined, 1)
  const timedOut = tickRun(offline, 240001)
  expect(timedOut).toMatchObject({ finish: 'not-back', settled: true })
  expect(observeConnection(timedOut, {}, host, 250000)).toBe(timedOut)
  const back = observeConnection(
    timedOut,
    {},
    { ...host, cursor: { epoch: 'next', seq: 0 } },
    250000,
  )
  expect(back).toMatchObject({ finish: 'rolled-back', reached: 'health' })
  expect(nextRun(back, 250000).step).toBe('paused') // skips waiting on a legacy Host
})

it('accepts only a new owner result from the same installed version, without comparing clocks', () => {
  const last = { from: '1.2.3', to: '1.3.0', at: 'future', outcome: 'rolled-back' } as const
  const run = startRun('op', { last }, host, 0)
  expect(observeConnection(run, { last }, host, 1)).toBe(run)
  expect(observeConnection(run, { last: { ...last, at: 'past' } }, host, 2)).toMatchObject({
    finish: 'rolled-back',
    to: '1.3.0',
  })
})

it.each([
  ['done', { outcome: 'current' }, 'current'],
  ['done', { outcome: 'not-paused', pause: 'cancelled' }, 'cancelled'],
  ['done', { outcome: 'not-paused', pause: 'timed-out' }, 'still-working'],
  ['failed', {}, 'download'],
] as const)('reads a %s job result (%j) as %s', (state, data, finish) => {
  const run = startRun('op', {}, host, 0)
  expect(
    readUpdateJob(
      run,
      {
        status: 'ok',
        applies: 'now',
        text: '',
        data: { op: 'service.update', state, result: { text: 'detail', data } },
      },
      1,
    ),
  ).toMatchObject({ finish })
})

it('times out a stalled download and does not reset live counts on an absent pause read', () => {
  const run = startRun('op', {}, host, 0)
  expect(tickRun(run, 900_000)).toMatchObject({ finish: 'download' })
  const draining = observePause(run, waiting, 1)
  expect(observePause(draining, undefined, 2)).toBe(draining)
})

it('selects the update path from capabilities and infers a newer version from peers only', () => {
  const input = {
    machineId: 'm',
    label: 'dev',
    host,
    peers: [{ ...host, hostVersion: '1.4.0' }],
    entry: {},
    configure: true,
    terminal: true,
    owner: false,
  }
  expect(deriveMachineUpdate(input)).toMatchObject({
    path: 'op',
    phase: 'available',
    available: '1.4.0',
    availableFrom: 'peer',
    can: { start: true },
  })
  expect(deriveMachineUpdate({ ...input, host: { ...host, ops: undefined } }).path).toBe('task')
  expect(deriveMachineUpdate({ ...input, configure: false }).can.start).toBe(false)
})

it('only shows controls during a live pause and with explicit support or the owner IPC', () => {
  const run = nextRun(observePause(startRun('op', {}, host, 0), waiting, 10), 600)
  const input = {
    machineId: 'm',
    label: 'dev',
    host,
    peers: [],
    entry: { run, status: { pause: waiting } },
    configure: true,
    terminal: true,
    owner: false,
  }
  expect(deriveMachineUpdate(input).can.stopTurns).toBe(false)
  expect(deriveMachineUpdate({ ...input, owner: true }).can.stopTurns).toBe(true)
  const status = readUpdateStatus({ pause: waiting, update: { pauseControl: true } })
  expect(deriveMachineUpdate({ ...input, entry: { run, status } }).can.cancel).toBe(true)
})
