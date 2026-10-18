import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type LaneOp } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { ProviderLogins } from '../providers/login'
import { TerminalForbidden, type HostTerminals } from '../terminals/service'
import {
  createLaneCommands,
  type LaneCommandClient,
  type LaneCommandFrame,
  type LaneCommandPorts,
} from './commands'
import {
  createCommandsFixture,
  deferred,
  type CommandsFixture,
} from './__fixtures__/commands.fixture'

// Characterizes the machine-scoped families (repositories, routines, provider
// login and machine terminals) through createLaneCommands before HA-09 moves them.

const EVERY: readonly HostCapability[] = [
  'sessions.read',
  'sessions.control',
  'workspaces.read',
  'workspaces.write',
  'artifacts.read',
  'skills.read',
  'terminal',
  'routines',
]

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

function machinePorts() {
  const repositories = vi.fn<NonNullable<LaneCommandPorts['repositories']>['execute']>(
    async () => ({ ok: true }),
  )
  const routines = vi.fn<NonNullable<LaneCommandPorts['routines']>['execute']>(async () => null)
  const login = vi.fn<ProviderLogins['execute']>(async () => ({ terminalId: 'login' }))
  const machineOp = vi.fn<HostTerminals['machineOp']>(() => null)
  const laneTerminal = vi.fn<HostTerminals['execute']>(async () => null)
  f.ports.repositories = { execute: repositories }
  f.ports.routines = { execute: routines }
  f.ports.providerLogins = { execute: login }
  f.ports.terminals = { machineOp, execute: laneTerminal } as unknown as HostTerminals
  f.service = createLaneCommands(f.ports)
  return { repositories, routines, login, machineOp, laneTerminal }
}
const client = (): LaneCommandClient => ({ ...f.one, caps: EVERY })
const command = (op: LaneOp, extra: Partial<LaneCommandFrame> = {}): LaneCommandFrame => ({
  type: 'command',
  requestId: randomUUID(),
  op,
  ...extra,
})
const recorded = (request: LaneCommandFrame) => f.store.getReceipt(request.requestId, f.one.id)
const add: LaneOp = { type: 'host.repositories.add', path: 'repo' }
const pause: LaneOp = { type: 'routine.pauseAll' }
const login: LaneOp = { type: 'provider.login', provider: 'xai' }
const kill = (): LaneOp => ({ type: 'terminal.kill', terminalId: randomUUID() })
const commandLog = (request: LaneCommandFrame) =>
  f.logs.find(
    (entry) =>
      entry.message === 'lane.command' &&
      (entry.data as { requestId?: string }).requestId === request.requestId,
  )?.data

describe('machine operations refuse lane and fence fields', () => {
  it.each([
    ['repository with a lane id', () => command(add, { laneId: f.lane.laneId }), 'bad-request'],
    ['repository with a fence', () => command(add, { fence: 1 }), 'bad-request'],
    [
      'repository with an unknown lane',
      () => command(add, { laneId: randomUUID() }),
      'bad-request',
    ],
    ['routine with a lane id', () => command(pause, { laneId: f.lane.laneId }), 'bad-request'],
    ['routine with a fence', () => command(pause, { fence: 1 }), 'bad-request'],
    ['provider login with a fence', () => command(login, { fence: 1 }), 'bad-request'],
    [
      'provider login with a lane id',
      () => command(login, { laneId: f.lane.laneId }),
      'bad-request',
    ],
    ['machine terminal with a fence', () => command(kill(), { fence: 1 }), 'bad-request'],
    [
      'terminal on an unknown lane',
      () => command(kill(), { laneId: randomUUID() }),
      'unknown-lane',
    ],
  ] as const)('records %s as %s, without calling a port', async (_name, request, code) => {
    const ports = machinePorts()
    const frame = request()
    await f.service.submit(client(), frame)
    expect(recorded(frame)).toEqual({ requestId: frame.requestId, status: 'rejected', code })
    for (const spy of Object.values(ports)) expect(spy).not.toHaveBeenCalled()
    expect(f.events).toEqual([])
  })

  it('answers missing ports by family: repositories bad-request, routines unsupported, terminals unknown', async () => {
    const expected = [
      [command(add), 'bad-request'],
      [command(pause, { laneId: f.lane.laneId, fence: 1 }), 'unsupported'],
      [command(login), 'unknown'],
      [command(kill()), 'unknown'],
    ] as const
    for (const [frame, code] of expected) {
      await f.service.submit(client(), frame)
      expect(recorded(frame)).toEqual(
        code === 'unknown'
          ? { requestId: frame.requestId, status: 'unknown' }
          : { requestId: frame.requestId, status: 'rejected', code },
      )
    }
  })

  it('refuses repositories before owed control republication, and routines and logins after it', async () => {
    const ports = machinePorts()
    const publish = f.ports.publish
    f.ports.publish = vi.fn(publish).mockImplementationOnce(() => {
      throw new Error('stream failed')
    })
    await f.service.submit(client(), f.frame({ type: 'control.take' }))
    expect(f.events).toEqual([])
    const repository = command(add, { laneId: f.lane.laneId })
    await f.service.submit(client(), repository)
    expect(recorded(repository)).toMatchObject({ status: 'rejected', code: 'bad-request' })
    expect(f.events).toEqual([])
    const routine = command(pause, { laneId: f.lane.laneId })
    await f.service.submit(client(), routine)
    expect(f.events.map(({ event }) => event)).toEqual([
      { kind: 'control', control: expect.objectContaining({ fence: 2 }) },
    ])
    expect(recorded(routine)).toMatchObject({ status: 'rejected', code: 'bad-request' })
    vi.mocked(f.ports.publish).mockImplementationOnce(() => {
      throw new Error('stream failed')
    })
    await f.service.submit(client(), f.frame({ type: 'control.take' }, 2))
    vi.mocked(f.ports.publish).mockImplementationOnce(() => {
      throw new Error('stream failed again')
    })
    const owed = command(login, { laneId: f.lane.laneId })
    await f.service.submit(client(), owed)
    expect(recorded(owed)).toMatchObject({ status: 'failed', error: { code: 'internal' } })
    expect(ports.login).not.toHaveBeenCalled()
    expect(ports.routines).not.toHaveBeenCalled()
  })
})

describe('machine outcome mapping', () => {
  it('maps repository data, refusals and deadlines, and passes a live authority callback', async () => {
    const ports = machinePorts()
    let live: readonly HostCapability[] = EVERY
    const current: LaneCommandClient = { ...client(), currentCaps: () => live }
    ports.repositories
      .mockResolvedValueOnce({ ok: true, data: { repositoryId: 'r' } })
      .mockResolvedValueOnce({ ok: false, code: 'conflict' })
    const done = command(add)
    await f.service.submit(current, done)
    expect(recorded(done)).toEqual({
      requestId: done.requestId,
      status: 'done',
      data: { repositoryId: 'r' },
    })
    const refused = command({ type: 'host.repositories.remove', repositoryId: f.lane.repositoryId })
    await f.service.submit(current, refused)
    expect(recorded(refused)).toEqual({
      requestId: refused.requestId,
      status: 'rejected',
      code: 'conflict',
    })
    const hold = deferred<{ ok: true }>()
    let allowed: (() => boolean) | undefined
    ports.repositories.mockImplementationOnce((_op, check) => {
      allowed = check
      return hold.promise
    })
    const slow = command({ type: 'host.repositories.createFolder', path: 'new' })
    const running = f.service.submit(current, slow)
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    await running
    expect(recorded(slow)).toEqual({ requestId: slow.requestId, status: 'unknown' })
    expect(commandLog(slow)).toMatchObject({ status: 'unknown', reason: undefined })
    live = ['workspaces.write']
    expect(allowed?.()).toBe(false)
    hold.release({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(recorded(slow)?.status).toBe('unknown')
    expect(ports.repositories).toHaveBeenCalledWith(slow.op, expect.any(Function))
  })

  it('maps routine data, failures and deadlines without a reason', async () => {
    const ports = machinePorts()
    ports.routines
      .mockResolvedValueOnce({ paused: 1 })
      .mockRejectedValueOnce(new Error('private routine failure'))
      .mockImplementationOnce(() => new Promise(() => {}))
    const done = command(pause)
    await f.service.submit(client(), done)
    expect(recorded(done)).toEqual({
      requestId: done.requestId,
      status: 'done',
      data: { paused: 1 },
    })
    const failed = command({ type: 'routine.archive', routineId: randomUUID() })
    await f.service.submit(client(), failed)
    expect(recorded(failed)).toEqual({ requestId: failed.requestId, status: 'unknown' })
    const slow = command({ type: 'routine.skipNext', routineId: randomUUID() })
    const running = f.service.submit(client(), slow)
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    await running
    expect(recorded(slow)).toEqual({ requestId: slow.requestId, status: 'unknown' })
    for (const request of [failed, slow])
      expect(commandLog(request)).toMatchObject({ reason: undefined })
    expect(JSON.stringify(f.logs)).not.toContain('private routine failure')
  })

  it('maps provider login and machine terminal results, and refuses at dispatch after a lost grant', async () => {
    const ports = machinePorts()
    const started = command(login)
    await f.service.submit(client(), started)
    expect(recorded(started)).toEqual({
      requestId: started.requestId,
      status: 'done',
      data: { terminalId: 'login' },
    })
    expect(ports.login).toHaveBeenCalledWith(login, f.one.id, expect.any(Function))
    ports.login.mockRejectedValueOnce(new Error('too-many-requests'))
    const busy = command(login)
    await f.service.submit(client(), busy)
    expect(recorded(busy)).toEqual({ requestId: busy.requestId, status: 'unknown' })
    const killed = command(kill())
    await f.service.submit(client(), killed)
    expect(recorded(killed)).toEqual({ requestId: killed.requestId, status: 'done', data: null })
    expect(ports.machineOp).toHaveBeenCalledWith(f.one.id, killed.op)
    ports.machineOp.mockImplementationOnce(() => {
      throw new TerminalForbidden('forbidden')
    })
    const foreign = command(kill())
    await f.service.submit(client(), foreign)
    expect(recorded(foreign)).toEqual({ requestId: foreign.requestId, status: 'unknown' })
    let reads = 0
    const losing: LaneCommandClient = { ...client(), currentCaps: () => (++reads < 3 ? EVERY : []) }
    const lost = command(kill())
    await f.service.submit(losing, lost)
    expect(reads).toBe(3)
    expect(recorded(lost)).toEqual({ requestId: lost.requestId, status: 'unknown' })
    expect(ports.machineOp).toHaveBeenCalledTimes(2)
    expect(ports.laneTerminal).not.toHaveBeenCalled()
  })
})

describe('machine queue order', () => {
  it('runs repository, routine, login, terminal and creation one at a time in submission order', async () => {
    const ports = machinePorts()
    const order: string[] = []
    const gates = Array.from({ length: 3 }, () => deferred<void>())
    const step =
      <T>(name: string, index: number, value: T) =>
      async () => {
        order.push(name)
        await gates[index]?.promise
        return value
      }
    ports.repositories.mockImplementationOnce(step('repository', 0, { ok: true as const }))
    ports.routines.mockImplementationOnce(step('routine', 1, null))
    ports.login.mockImplementationOnce(step('login', 2, { terminalId: 'login' }))
    ports.machineOp.mockImplementationOnce(() => {
      order.push('terminal')
      return null
    })
    vi.mocked(f.ports.sessions.start).mockImplementationOnce(async () => {
      order.push('create')
      return { sessionId: 'new-session', sessionFile: null }
    })
    const frames = [
      command(add),
      command(pause),
      command(login),
      command(kill()),
      command({ type: 'lane.create', repositoryId: f.lane.repositoryId, worktree: null }),
    ]
    const runs = frames.map((frame) => f.service.submit(client(), frame))
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['repository'])
    for (const [index, gate] of gates.slice(0, 2).entries()) {
      gate.release()
      await vi.advanceTimersByTimeAsync(0)
      expect(order).toHaveLength(index + 2)
    }
    gates[2]?.release()
    await Promise.all(runs)
    expect(order).toEqual(['repository', 'routine', 'login', 'terminal', 'create'])
    expect(frames.map((frame) => recorded(frame)?.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ])
  })
})
