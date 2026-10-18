import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaneOp } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { HostAttachments } from '../features/attachments'
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

// Characterizes capability admission through createLaneCommands before HA-07 makes
// the queued-execution check uniform. Only behaviour that holds today is pinned here.

const CONTROL: readonly HostCapability[] = ['sessions.control']
const WRITE: readonly HostCapability[] = ['workspaces.write', 'sessions.control']
const TERMINAL: readonly HostCapability[] = ['terminal', 'sessions.control']
const ROUTINES: readonly HostCapability[] = ['routines']
const ROUTINE_CONTROL: readonly HostCapability[] = ['routines', 'sessions.control']
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

const routineInput = (enabled: boolean, trusted: boolean) => ({
  name: 'Report',
  instructions: 'Report.',
  repositoryId: '0123456789abcdef',
  isolated: false,
  intent: 'report' as const,
  provider: 'fake',
  model: 'fake-model',
  timezone: 'UTC',
  schedule: { kind: 'manual' as const },
  period: 'none' as const,
  catchUpHours: 0,
  maxRuntimeMinutes: 30,
  enabled,
  trusted,
})
const uploadId = 'a'.repeat(32)
const save = (enabled: boolean, trusted: boolean): LaneOp => ({
  type: 'routine.save',
  routine: routineInput(enabled, trusted),
  expectedRevision: null,
})

/** Every operation family and the capabilities capabilityFor reports for it today. */
const TABLE: [string, readonly HostCapability[], LaneOp][] = [
  ['prompt', CONTROL, { type: 'prompt', message: 'x' }],
  ['steer', CONTROL, { type: 'steer', message: 'x' }],
  ['follow_up', CONTROL, { type: 'follow_up', message: 'x' }],
  ['abort', CONTROL, { type: 'abort' }],
  ['abort_retry', CONTROL, { type: 'abort_retry' }],
  ['set_model', CONTROL, { type: 'set_model', provider: 'p', modelId: 'm' }],
  ['set_thinking_level', CONTROL, { type: 'set_thinking_level', level: 'off' }],
  ['compact', CONTROL, { type: 'compact' }],
  ['set_session_name', CONTROL, { type: 'set_session_name', name: 'x' }],
  [
    'extension_ui_response',
    CONTROL,
    {
      type: 'extension_ui_response',
      response: { type: 'extension_ui_response', id: 'dialog', confirmed: true },
    },
  ],
  [
    'lane.create',
    CONTROL,
    { type: 'lane.create', repositoryId: '0123456789abcdef', worktree: null },
  ],
  ['lane.resume', CONTROL, { type: 'lane.resume' }],
  ['lane.stop', CONTROL, { type: 'lane.stop' }],
  ['lane.markRead', CONTROL, { type: 'lane.markRead', upTo: 1 }],
  ['control.take', CONTROL, { type: 'control.take' }],
  ['control.release', CONTROL, { type: 'control.release' }],
  ['host.repositories.add', WRITE, { type: 'host.repositories.add', path: 'repo' }],
  [
    'host.repositories.remove',
    WRITE,
    { type: 'host.repositories.remove', repositoryId: '0123456789abcdef' },
  ],
  [
    'host.repositories.createFolder',
    WRITE,
    { type: 'host.repositories.createFolder', path: 'folder' },
  ],
  [
    'lane.delete',
    WRITE,
    { type: 'lane.delete', laneId: randomUUID(), removeWorktree: false, removeBranch: false },
  ],
  ['attachments.begin', WRITE, { type: 'attachments.begin', name: 'a.txt', size: 1, mime: '' }],
  ['attachments.chunk', WRITE, { type: 'attachments.chunk', uploadId, index: 0, data: 'AAAA' }],
  ['attachments.commit', WRITE, { type: 'attachments.commit', uploadId, sha256: 'b'.repeat(64) }],
  ['terminal.create', TERMINAL, { type: 'terminal.create', cols: 80, rows: 24 }],
  [
    'terminal.resize',
    TERMINAL,
    { type: 'terminal.resize', terminalId: randomUUID(), cols: 80, rows: 24 },
  ],
  ['terminal.kill', TERMINAL, { type: 'terminal.kill', terminalId: randomUUID() }],
  ['provider.login', TERMINAL, { type: 'provider.login', provider: 'xai' }],
  ['routine.save paused untrusted', ROUTINES, save(false, false)],
  ['routine.cancel', ROUTINES, { type: 'routine.cancel', runId: randomUUID() }],
  ['routine.skipNext', ROUTINES, { type: 'routine.skipNext', routineId: randomUUID() }],
  ['routine.archive', ROUTINES, { type: 'routine.archive', routineId: randomUUID() }],
  ['routine.pauseAll', ROUTINES, { type: 'routine.pauseAll' }],
  ['routine.save paused trusted', ROUTINE_CONTROL, save(false, true)],
  ['routine.save enabled trusted', ROUTINE_CONTROL, save(true, true)],
  ['routine.run', ROUTINE_CONTROL, { type: 'routine.run', routineId: randomUUID() }],
  ['routine.delete', ROUTINE_CONTROL, { type: 'routine.delete', routineId: randomUUID() }],
]
const FILE_OPS: LaneOp[] = [
  { type: 'files.write', path: 'a', content: 'x', expected: null },
  { type: 'files.create', path: 'a', kind: 'file' },
  { type: 'files.rename', from: 'a', to: 'b' },
  { type: 'files.delete', path: 'a' },
  { type: 'files.transfer', source: 'a', directory: 'b', mode: 'copy' },
]

/** Feature ports that record calls and answer success unless a test overrides them. */
function featurePorts(f: CommandsFixture) {
  const repositories = vi.fn<NonNullable<LaneCommandPorts['repositories']>['execute']>(
    async () => ({ ok: true }),
  )
  const deleteLane = vi.fn<NonNullable<LaneCommandPorts['deleteLane']>>(async () => ({
    ok: true,
    data: { branchKept: false },
  }))
  const login = vi.fn<ProviderLogins['execute']>(async () => ({ terminalId: randomUUID() }))
  const attach = vi.fn<HostAttachments['execute']>(async () => ({ ok: true }))
  const abort = vi.fn<HostAttachments['abort']>()
  const laneTerminal = vi.fn<HostTerminals['execute']>(async () => ({ terminalId: 'lane' }))
  const machineTerminal = vi.fn<HostTerminals['machineOp']>(() => null)
  const write = vi.fn<NonNullable<LaneCommandPorts['writes']>['execute']>(async () => ({
    ok: true,
  }))
  const routines = vi.fn<NonNullable<LaneCommandPorts['routines']>['execute']>(async () => null)
  f.ports.repositories = { execute: repositories }
  f.ports.deleteLane = deleteLane
  f.ports.providerLogins = { execute: login }
  f.ports.attachments = { execute: attach, abort } as unknown as HostAttachments
  f.ports.terminals = {
    execute: laneTerminal,
    machineOp: machineTerminal,
  } as unknown as HostTerminals
  f.ports.writes = { capabilityFor: () => 'workspaces.write', execute: write }
  f.ports.routines = { execute: routines }
  f.service = createLaneCommands(f.ports)
  const calls = () =>
    [repositories, deleteLane, login, attach, laneTerminal, machineTerminal, write, routines]
      .map((spy) => spy.mock.calls.length)
      .reduce((sum, count) => sum + count, 0)
  return {
    repositories,
    deleteLane,
    login,
    attach,
    laneTerminal,
    machineTerminal,
    write,
    routines,
    calls,
  }
}

const machine = (op: LaneOp, extra: Partial<LaneCommandFrame> = {}): LaneCommandFrame => ({
  type: 'command',
  requestId: randomUUID(),
  op,
  ...extra,
})

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

describe('capabilityFor reports each operation family', () => {
  it.each(TABLE)('%s requires its capability set', (_name, caps, op) => {
    featurePorts(f)
    expect(f.service.capabilityFor(op)).toEqual(caps)
  })

  it.each(FILE_OPS.map((op) => [op.type, op] as const))(
    '%s requires the write port capability plus sessions.control, or only control without one',
    (_type, op) => {
      expect(f.service.capabilityFor(op)).toEqual(CONTROL)
      featurePorts(f)
      expect(f.service.capabilityFor(op)).toEqual(WRITE)
      f.ports.writes = { capabilityFor: () => null, execute: vi.fn() }
      expect(createLaneCommands(f.ports).capabilityFor(op)).toEqual(CONTROL)
    },
  )
})

describe('submission refuses a missing capability before recording', () => {
  it.each(TABLE)(
    '%s is forbidden, unrecorded, for each missing capability',
    async (_n, caps, op) => {
      const ports = featurePorts(f)
      for (const missing of caps) {
        const client: LaneCommandClient = {
          ...f.one,
          caps: EVERY.filter((cap) => cap !== missing),
        }
        // A lane id and fence on a machine op would be bad-request; forbidden comes first.
        const request = f.frame(op)
        await f.service.submit(client, request)
        expect(f.last(request.requestId)).toEqual({
          requestId: request.requestId,
          status: 'rejected',
          code: 'forbidden',
        })
        expect(f.store.getReceipt(request.requestId, client.id)).toBeNull()
      }
      expect(ports.calls()).toBe(0)
      expect(f.command).not.toHaveBeenCalled()
      expect(f.respond).not.toHaveBeenCalled()
      expect(f.events).toEqual([])
      expect(f.store.getLane(f.lane.laneId)?.control).toEqual({ fence: 1, controller: null })
      expect(f.ports.sessions.start).not.toHaveBeenCalled()
    },
  )

  it('reads current capabilities at submission and refuses before returning a recorded receipt', async () => {
    let live: readonly HostCapability[] = CONTROL
    const client: LaneCommandClient = { ...f.one, caps: CONTROL, currentCaps: () => live }
    const request = f.frame({ type: 'control.take' })
    await f.service.submit(client, request)
    const recorded = f.last(request.requestId)
    expect(recorded).toMatchObject({ status: 'done', fence: 2 })
    live = ['sessions.read']
    await f.service.submit(client, request)
    expect(f.last(request.requestId)).toMatchObject({ status: 'rejected', code: 'forbidden' })
    expect(f.store.getReceipt(request.requestId, client.id)).toEqual(recorded)
    live = []
    const closed = f.frame({ type: 'abort' }, 2)
    await f.service.submit(client, closed)
    expect(f.last(closed.requestId)).toMatchObject({ status: 'rejected', code: 'forbidden' })
    expect(f.store.getReceipt(closed.requestId, client.id)).toBeNull()
    expect(f.command).not.toHaveBeenCalled()
  })
})

/** Hold one queue with a non-detached blocker so a later submission waits behind it. */
function blocker(f: CommandsFixture, scope: 'lane' | 'machine') {
  const gate = deferred<void>()
  const holder: LaneCommandClient = { ...f.two, caps: EVERY }
  if (scope === 'lane') {
    f.ports.stopLane = vi.fn(() => gate.promise)
    const fence = f.store.getLane(f.lane.laneId)?.control.fence
    const held = f.service.submit(f.one, f.frame({ type: 'lane.stop' }, fence))
    return { held, release: () => gate.release() }
  }
  const repositories = f.ports.repositories
  if (!repositories) throw new Error('missing repositories port')
  const execute = vi.mocked(repositories.execute)
  execute.mockImplementationOnce(async () => {
    await gate.promise
    return { ok: true }
  })
  const held = f.service.submit(holder, machine({ type: 'host.repositories.add', path: 'held' }))
  return { held, release: () => gate.release() }
}

type PortSpy = Exclude<keyof ReturnType<typeof featurePorts>, 'calls'>
/** Families that already recheck capabilities when a queued operation starts. */
const RECHECKED: [string, 'lane' | 'machine', readonly HostCapability[], () => LaneOp, PortSpy][] =
  [
    [
      'host.repositories.add',
      'machine',
      WRITE,
      () => ({ type: 'host.repositories.add', path: 'repo' }),
      'repositories',
    ],
    [
      'lane.delete',
      'lane',
      WRITE,
      () => ({
        type: 'lane.delete',
        laneId: f.lane.laneId,
        removeWorktree: false,
        removeBranch: false,
      }),
      'deleteLane',
    ],
    [
      'attachments.begin',
      'lane',
      WRITE,
      () => ({ type: 'attachments.begin', name: 'a.txt', size: 1, mime: '' }),
      'attach',
    ],
    [
      'files.create',
      'lane',
      WRITE,
      () => ({ type: 'files.create', path: 'a', kind: 'file' }),
      'write',
    ],
    [
      'lane terminal.create',
      'lane',
      TERMINAL,
      () => ({ type: 'terminal.create', cols: 80, rows: 24 }),
      'laneTerminal',
    ],
    [
      'machine terminal.kill',
      'machine',
      TERMINAL,
      () => ({ type: 'terminal.kill', terminalId: randomUUID() }),
      'machineTerminal',
    ],
    [
      'provider.login',
      'machine',
      TERMINAL,
      () => ({ type: 'provider.login', provider: 'xai' }),
      'login',
    ],
    ['routine.pauseAll', 'machine', ROUTINES, () => ({ type: 'routine.pauseAll' }), 'routines'],
    [
      'routine.run',
      'machine',
      ROUTINE_CONTROL,
      () => ({ type: 'routine.run', routineId: randomUUID() }),
      'routines',
    ],
  ]

describe('queued families that already recheck current capabilities', () => {
  it.each(RECHECKED)(
    'refuses queued %s as recorded forbidden after losing any required capability',
    async (_name, scope, caps, op, port) => {
      for (const missing of caps) {
        const ports = featurePorts(f)
        const { held, release } = blocker(f, scope)
        let live: readonly HostCapability[] = EVERY
        const client: LaneCommandClient = { ...f.one, caps: EVERY, currentCaps: () => live }
        const fence = f.store.getLane(f.lane.laneId)?.control.fence
        const request = scope === 'lane' ? f.frame(op(), fence) : machine(op())
        const queued = f.service.submit(client, request)
        const calls = ports[port].mock.calls.length
        live = EVERY.filter((cap) => cap !== missing)
        release()
        await Promise.all([held, queued])
        expect(f.store.getReceipt(request.requestId, client.id)).toEqual({
          requestId: request.requestId,
          status: 'rejected',
          code: 'forbidden',
        })
        expect(ports[port].mock.calls.length).toBe(calls)
      }
    },
  )
})

const recorded = (request: LaneCommandFrame) => f.store.getReceipt(request.requestId, f.one.id)
const everything = (): LaneCommandClient => ({ ...f.one, caps: EVERY })

describe('scope, fence and missing-port refusals once capabilities hold', () => {
  it('records repository ops as bad-request without a port or with any lane scope', async () => {
    const op: LaneOp = { type: 'host.repositories.add', path: 'repo' }
    const noPort = machine(op)
    await f.service.submit(everything(), noPort)
    expect(recorded(noPort)).toMatchObject({ status: 'rejected', code: 'bad-request' })
    const ports = featurePorts(f)
    for (const extra of [
      { laneId: f.lane.laneId },
      { fence: 1 },
      { laneId: f.lane.laneId, fence: 1 },
    ]) {
      const request = machine(op, extra)
      await f.service.submit(everything(), request)
      expect(recorded(request)).toMatchObject({ status: 'rejected', code: 'bad-request' })
    }
    expect(ports.repositories).not.toHaveBeenCalled()
    const done = machine(op)
    await f.service.submit(everything(), done)
    expect(recorded(done)).toEqual({ requestId: done.requestId, status: 'done' })
    expect(f.store.getLane(f.lane.laneId)?.control.fence).toBe(1)
  })

  it('records a missing routine port as unsupported before any scope check', async () => {
    const op: LaneOp = { type: 'routine.pauseAll' }
    const scoped = machine(op, { laneId: f.lane.laneId, fence: 1 })
    await f.service.submit(everything(), scoped)
    expect(recorded(scoped)).toMatchObject({ status: 'rejected', code: 'unsupported' })
    const ports = featurePorts(f)
    for (const extra of [{ laneId: f.lane.laneId }, { fence: 1 }]) {
      const request = machine(op, extra)
      await f.service.submit(everything(), request)
      expect(recorded(request)).toMatchObject({ status: 'rejected', code: 'bad-request' })
    }
    expect(ports.routines).not.toHaveBeenCalled()
    ports.routines.mockResolvedValueOnce({ paused: 2 })
    const done = machine(op)
    await f.service.submit(everything(), done)
    expect(recorded(done)).toEqual({
      requestId: done.requestId,
      status: 'done',
      data: { paused: 2 },
    })
  })

  it('maps provider login and machine terminal scope to bad-request and missing ports to unknown', async () => {
    const login: LaneOp = { type: 'provider.login', provider: 'xai' }
    const kill: LaneOp = { type: 'terminal.kill', terminalId: randomUUID() }
    for (const op of [login, kill]) {
      const request = machine(op)
      await f.service.submit(everything(), request)
      expect(recorded(request)).toEqual({ requestId: request.requestId, status: 'unknown' })
    }
    const ports = featurePorts(f)
    for (const request of [
      machine(login, { fence: 1 }),
      machine(login, { laneId: f.lane.laneId }),
      machine(kill, { fence: 1 }),
    ]) {
      await f.service.submit(everything(), request)
      expect(recorded(request)).toMatchObject({ status: 'rejected', code: 'bad-request' })
    }
    expect(ports.login).not.toHaveBeenCalled()
    expect(ports.machineTerminal).not.toHaveBeenCalled()
    // A machine terminal refusal is a transport failure, not a forbidden receipt.
    ports.machineTerminal.mockImplementationOnce(() => {
      throw new TerminalForbidden('forbidden')
    })
    const refused = machine(kill)
    await f.service.submit(everything(), refused)
    expect(recorded(refused)).toEqual({ requestId: refused.requestId, status: 'unknown' })
    const started = machine(login)
    ports.login.mockResolvedValueOnce({ terminalId: 'login' })
    await f.service.submit(everything(), started)
    expect(recorded(started)).toEqual({
      requestId: started.requestId,
      status: 'done',
      data: { terminalId: 'login' },
    })
    expect(ports.login).toHaveBeenCalledWith(login, f.one.id, expect.any(Function))
  })

  it('admits lane terminals and attachments before refusing a missing port as unsupported', async () => {
    const terminal = f.frame({ type: 'terminal.create', cols: 80, rows: 24 })
    await f.service.submit(everything(), terminal)
    expect(recorded(terminal)).toMatchObject({ status: 'rejected', code: 'unsupported' })
    expect(f.store.getLane(f.lane.laneId)?.control).toMatchObject({
      fence: 2,
      controller: { clientId: f.one.id },
    })
    expect(f.events.map(({ event }) => event.kind)).toEqual(['control'])
    const attachment = f.frame({ type: 'attachments.begin', name: 'a.txt', size: 1, mime: '' }, 2)
    await f.service.submit(everything(), attachment)
    expect(recorded(attachment)).toMatchObject({ status: 'rejected', code: 'unsupported' })
    const ports = featurePorts(f)
    ports.laneTerminal.mockRejectedValueOnce(new TerminalForbidden('forbidden'))
    const refused = f.frame({ type: 'terminal.create', cols: 80, rows: 24 }, 2)
    await f.service.submit(everything(), refused)
    expect(recorded(refused)).toMatchObject({ status: 'rejected', code: 'forbidden' })
    const stale = f.frame({ type: 'terminal.create', cols: 80, rows: 24 }, 1)
    await f.service.submit(everything(), stale)
    expect(recorded(stale)).toMatchObject({ status: 'rejected', code: 'stale-fence' })
    expect(ports.laneTerminal).toHaveBeenCalledTimes(1)
  })

  it('records files ops forbidden without a resolvable write capability, before lane checks', async () => {
    const op: LaneOp = { type: 'files.create', path: 'a', kind: 'file' }
    for (const request of [f.frame(op), f.frame(op, 1, randomUUID()), f.frame(op, 7)]) {
      await f.service.submit(everything(), request)
      expect(recorded(request)).toMatchObject({ status: 'rejected', code: 'forbidden' })
    }
    const execute = vi.fn(async () => ({ ok: true as const }))
    f.ports.writes = { capabilityFor: () => null, execute }
    f.service = createLaneCommands(f.ports)
    const unresolved = f.frame(op)
    await f.service.submit(everything(), unresolved)
    expect(recorded(unresolved)).toMatchObject({ status: 'rejected', code: 'forbidden' })
    expect(execute).not.toHaveBeenCalled()
    expect(f.events).toEqual([])
    expect(f.store.getLane(f.lane.laneId)?.control.fence).toBe(1)
  })

  it('checks lane deletion scope and controller before refusing a missing port as unsupported', async () => {
    const op = (laneId: string): LaneOp => ({
      type: 'lane.delete',
      laneId,
      removeWorktree: false,
      removeBranch: false,
    })
    f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
    const other = f.frame(op(randomUUID()), 2)
    await f.service.submit(everything(), other)
    expect(recorded(other)).toMatchObject({ status: 'rejected', code: 'not-controller' })
    const missing = f.frame(op(f.lane.laneId), 2)
    await f.service.submit(everything(), missing)
    expect(recorded(missing)).toMatchObject({ status: 'rejected', code: 'unsupported' })
    const ports = featurePorts(f)
    const stale = f.frame(op(f.lane.laneId), 1)
    await f.service.submit(everything(), stale)
    expect(recorded(stale)).toMatchObject({ status: 'rejected', code: 'stale-fence' })
    expect(ports.deleteLane).not.toHaveBeenCalled()
  })
})

describe('authority callbacks keep reading live state after their awaits', () => {
  it('passes repository, provider and lane terminal ports a live capability callback', async () => {
    const ports = featurePorts(f)
    let live: readonly HostCapability[] = EVERY
    const client: LaneCommandClient = { ...f.one, caps: EVERY, currentCaps: () => live }
    const seen: boolean[] = []
    const observe = (allowed: () => boolean, lost: HostCapability) => {
      seen.push(allowed())
      live = EVERY.filter((cap) => cap !== lost)
      seen.push(allowed())
      live = EVERY
      seen.push(allowed())
    }
    ports.repositories.mockImplementationOnce(async (_op, allowed) => {
      observe(allowed, 'workspaces.write')
      return { ok: true, data: { added: true } }
    })
    ports.login.mockImplementationOnce(async (_op, _owner, allowed) => {
      observe(allowed, 'terminal')
      return { terminalId: 'login' }
    })
    ports.laneTerminal.mockImplementationOnce(async (_laneId, _op, allowed) => {
      observe(allowed ?? (() => false), 'sessions.control')
      return { terminalId: 'lane' }
    })
    const repository = machine({ type: 'host.repositories.add', path: 'repo' })
    await f.service.submit(client, repository)
    await f.service.submit(client, machine({ type: 'provider.login', provider: 'xai' }))
    const terminal = f.frame({ type: 'terminal.create', cols: 80, rows: 24 })
    await f.service.submit(client, terminal)
    expect(seen).toEqual([true, false, true, true, false, true, true, false, true])
    expect(recorded(repository)).toEqual({
      requestId: repository.requestId,
      status: 'done',
      data: { added: true },
    })
    expect(recorded(terminal)).toEqual({
      requestId: terminal.requestId,
      status: 'done',
      data: { terminalId: 'lane' },
      fence: 2,
    })
  })

  it('gives deletion a callback that also requires the admitted fence and current controller', async () => {
    const ports = featurePorts(f)
    let live: readonly HostCapability[] = EVERY
    const client: LaneCommandClient = { ...f.one, caps: EVERY, currentCaps: () => live }
    f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
    const seen: boolean[] = []
    ports.deleteLane.mockImplementationOnce(async (_op, allowed) => {
      seen.push(allowed())
      live = CONTROL
      seen.push(allowed())
      live = EVERY
      seen.push(allowed())
      f.store.takeControl(f.lane.laneId, { clientId: f.two.id, label: f.two.label })
      seen.push(allowed())
      f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
      seen.push(allowed())
      return { ok: false, code: 'not-controller' }
    })
    const request = f.frame(
      { type: 'lane.delete', laneId: f.lane.laneId, removeWorktree: false, removeBranch: false },
      2,
    )
    await f.service.submit(client, request)
    expect(seen).toEqual([true, false, true, false, false])
    expect(recorded(request)).toMatchObject({ status: 'rejected', code: 'not-controller' })
  })

  it('passes a routine the capabilities read when its queued operation starts', async () => {
    const ports = featurePorts(f)
    const submitted: readonly HostCapability[] = ['routines', 'sessions.control', 'terminal']
    let live: readonly HostCapability[] = submitted
    const client: LaneCommandClient = { ...f.one, caps: submitted, currentCaps: () => live }
    const { held, release } = blocker(f, 'machine')
    const op: LaneOp = { type: 'routine.run', routineId: randomUUID() }
    const request = machine(op)
    const queued = f.service.submit(client, request)
    live = ['routines', 'sessions.control', 'skills.read']
    release()
    await Promise.all([held, queued])
    expect(ports.routines).toHaveBeenCalledWith(op, request.requestId, [
      'routines',
      'sessions.control',
      'skills.read',
    ])
    expect(recorded(request)).toEqual({ requestId: request.requestId, status: 'done', data: null })
  })
})
