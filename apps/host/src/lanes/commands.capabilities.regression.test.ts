import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaneOp } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { HostAttachments } from '../features/attachments'
import type { ProviderLogins } from '../providers/login'
import type { HostTerminals } from '../terminals/service'
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

// A queued operation must hold every capability capabilityFor names when it starts,
// read from the connection's current grant, not only when it was submitted.

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

const machine = (op: LaneOp): LaneCommandFrame => ({
  type: 'command',
  requestId: randomUUID(),
  op,
})
const forbidden = (request: LaneCommandFrame) => ({
  requestId: request.requestId,
  status: 'rejected',
  code: 'forbidden',
})
const fence = () => f.store.getLane(f.lane.laneId)?.control.fence

/** Feature ports that answer success, so only a capability refusal can stop them. */
function featurePorts() {
  const spies = {
    repositories: vi.fn<NonNullable<LaneCommandPorts['repositories']>['execute']>(async () => ({
      ok: true,
    })),
    deleteLane: vi.fn<NonNullable<LaneCommandPorts['deleteLane']>>(async () => ({
      ok: true,
      data: { branchKept: false },
    })),
    login: vi.fn<ProviderLogins['execute']>(async () => ({ terminalId: 'login' })),
    attach: vi.fn<HostAttachments['execute']>(async () => ({ ok: true })),
    laneTerminal: vi.fn<HostTerminals['execute']>(async () => ({ terminalId: 'lane' })),
    machineTerminal: vi.fn<HostTerminals['machineOp']>(() => null),
    write: vi.fn<NonNullable<LaneCommandPorts['writes']>['execute']>(async () => ({ ok: true })),
    routines: vi.fn<NonNullable<LaneCommandPorts['routines']>['execute']>(async () => null),
  }
  f.ports.repositories = { execute: spies.repositories }
  f.ports.deleteLane = spies.deleteLane
  f.ports.providerLogins = { execute: spies.login }
  f.ports.attachments = {
    execute: spies.attach,
    abort: vi.fn(),
  } as unknown as HostAttachments
  f.ports.terminals = {
    execute: spies.laneTerminal,
    machineOp: spies.machineTerminal,
  } as unknown as HostTerminals
  f.ports.writes = { capabilityFor: () => 'workspaces.write', execute: spies.write }
  f.ports.routines = { execute: spies.routines }
  f.service = createLaneCommands(f.ports)
  return spies
}

/** A non-detached operation that holds the lane or machine queue until released. */
function blocker(scope: 'lane' | 'machine') {
  const gate = deferred<void>()
  if (scope === 'lane') {
    f.ports.stopLane = vi.fn(() => gate.promise)
    const held = f.service.submit(f.one, f.frame({ type: 'lane.stop' }, fence()))
    return { held, release: () => gate.release() }
  }
  const hold = async () => {
    await gate.promise
    return { ok: true as const }
  }
  const repositories = f.ports.repositories
  if (repositories) vi.mocked(repositories.execute).mockImplementationOnce(hold)
  else f.ports.repositories = { execute: vi.fn(hold) }
  const holder: LaneCommandClient = { ...f.two, caps: EVERY }
  const held = f.service.submit(holder, machine({ type: 'host.repositories.add', path: 'held' }))
  return { held, release: () => gate.release() }
}

const dialog: LaneOp = {
  type: 'extension_ui_response',
  response: { type: 'extension_ui_response', id: 'dialog', confirmed: true },
}
const PLAIN: [string, LaneOp][] = [
  ['prompt', { type: 'prompt', message: 'x' }],
  ['steer', { type: 'steer', message: 'x' }],
  ['follow_up', { type: 'follow_up', message: 'x' }],
  ['abort', { type: 'abort' }],
  ['abort_retry', { type: 'abort_retry' }],
  ['set_model', { type: 'set_model', provider: 'p', modelId: 'm' }],
  ['set_thinking_level', { type: 'set_thinking_level', level: 'off' }],
  ['compact', { type: 'compact' }],
  ['set_session_name', { type: 'set_session_name', name: 'x' }],
  ['extension_ui_response', dialog],
  ['control.take', { type: 'control.take' }],
  ['control.release', { type: 'control.release' }],
  ['lane.markRead', { type: 'lane.markRead', upTo: 1 }],
  ['lane.resume', { type: 'lane.resume' }],
  ['lane.stop', { type: 'lane.stop' }],
]
const LOSSES = ['renewal', 'closed'] as const
/** A renewed grant without control, or the API's closed connection, which has no caps. */
function losingClient(loss: (typeof LOSSES)[number]) {
  let lost = false
  const client: LaneCommandClient = {
    ...f.one,
    caps: CONTROL,
    currentCaps: () => (!lost ? CONTROL : loss === 'renewal' ? ['sessions.read'] : []),
  }
  return { client, lose: () => (lost = true) }
}

describe('queued lane control and RPC operations after capability loss', () => {
  it.each(LOSSES.flatMap((loss) => PLAIN.map(([name, op]) => [name, loss, op] as const)))(
    'refuses queued %s after %s as recorded forbidden with no side effects',
    async (_name, loss, op) => {
      f.store.bumpAttention(f.lane.laneId)
      const { held, release } = blocker('lane')
      // lane.resume only acts on a stopped lane.
      if (op.type === 'lane.resume') f.sessions.clear()
      const before = f.store.getLane(f.lane.laneId)
      const events = f.events.length
      const { client, lose } = losingClient(loss)
      const request = f.frame(op, fence())
      const queued = f.service.submit(client, request)
      lose()
      release()
      await held
      await vi.advanceTimersByTimeAsync(0)
      expect(f.store.getReceipt(request.requestId, client.id)).toEqual(forbidden(request))
      expect(f.last(request.requestId)).toEqual(forbidden(request))
      expect(f.command).not.toHaveBeenCalled()
      expect(f.respond).not.toHaveBeenCalled()
      expect(f.ports.resumeLane).not.toHaveBeenCalled()
      expect(f.ports.stopLane).toHaveBeenCalledTimes(1)
      expect(f.events).toHaveLength(events)
      expect(f.store.getLane(f.lane.laneId)).toEqual(before)
      await queued
    },
  )

  it.each(LOSSES)(
    'refuses a queued lane.create after %s without starting anything',
    async (loss) => {
      const { held, release } = blocker('machine')
      const lanes = f.store.listLanes()
      const { client, lose } = losingClient(loss)
      const request = machine({
        type: 'lane.create',
        repositoryId: f.lane.repositoryId,
        worktree: null,
      })
      const queued = f.service.submit(client, request)
      lose()
      release()
      await held
      await vi.advanceTimersByTimeAsync(0)
      expect(f.store.getReceipt(request.requestId, client.id)).toEqual(forbidden(request))
      expect(f.ports.sessions.start).not.toHaveBeenCalled()
      expect(f.ports.sessions.attach).not.toHaveBeenCalled()
      expect(f.store.listLanes()).toEqual(lanes)
      expect(f.events).toEqual([])
      await queued
    },
  )
})

type Spy = keyof ReturnType<typeof featurePorts>
type Family = {
  name: string
  scope: 'lane' | 'machine'
  caps: readonly HostCapability[]
  op: () => LaneOp
  ran: (spies: ReturnType<typeof featurePorts>) => number
}
const port =
  (spy: Spy): Family['ran'] =>
  (spies) =>
    spies[spy].mock.calls.length
const FAMILIES: Family[] = [
  {
    name: 'prompt',
    scope: 'lane',
    caps: CONTROL,
    op: () => ({ type: 'prompt', message: 'x' }),
    ran: () => f.command.mock.calls.length,
  },
  {
    name: 'extension_ui_response',
    scope: 'lane',
    caps: CONTROL,
    op: () => dialog,
    ran: () => f.respond.mock.calls.length,
  },
  {
    name: 'control.take',
    scope: 'lane',
    caps: CONTROL,
    op: () => ({ type: 'control.take' }),
    ran: () => f.events.length,
  },
  {
    name: 'lane.markRead',
    scope: 'lane',
    caps: CONTROL,
    op: () => ({ type: 'lane.markRead', upTo: 1000 }),
    ran: () => f.store.getLane(f.lane.laneId)?.read ?? 0,
  },
  {
    name: 'lane.create',
    scope: 'machine',
    caps: CONTROL,
    op: () => ({ type: 'lane.create', repositoryId: f.lane.repositoryId, worktree: null }),
    ran: () => vi.mocked(f.ports.sessions.start).mock.calls.length,
  },
  {
    name: 'host.repositories.add',
    scope: 'machine',
    caps: WRITE,
    op: () => ({ type: 'host.repositories.add', path: 'repo' }),
    ran: port('repositories'),
  },
  {
    name: 'lane.delete',
    scope: 'lane',
    caps: WRITE,
    op: () => ({
      type: 'lane.delete',
      laneId: f.lane.laneId,
      removeWorktree: false,
      removeBranch: false,
    }),
    ran: port('deleteLane'),
  },
  {
    name: 'attachments.begin',
    scope: 'lane',
    caps: WRITE,
    op: () => ({ type: 'attachments.begin', name: 'a.txt', size: 1, mime: '' }),
    ran: port('attach'),
  },
  {
    name: 'files.create',
    scope: 'lane',
    caps: WRITE,
    op: () => ({ type: 'files.create', path: 'a', kind: 'file' }),
    ran: port('write'),
  },
  {
    name: 'lane terminal.create',
    scope: 'lane',
    caps: TERMINAL,
    op: () => ({ type: 'terminal.create', cols: 80, rows: 24 }),
    ran: port('laneTerminal'),
  },
  {
    name: 'machine terminal.kill',
    scope: 'machine',
    caps: TERMINAL,
    op: () => ({ type: 'terminal.kill', terminalId: randomUUID() }),
    ran: port('machineTerminal'),
  },
  {
    name: 'provider.login',
    scope: 'machine',
    caps: TERMINAL,
    op: () => ({ type: 'provider.login', provider: 'xai' }),
    ran: port('login'),
  },
  {
    name: 'routine.pauseAll',
    scope: 'machine',
    caps: ROUTINES,
    op: () => ({ type: 'routine.pauseAll' }),
    ran: port('routines'),
  },
  {
    name: 'routine.run',
    scope: 'machine',
    caps: ROUTINE_CONTROL,
    op: () => ({ type: 'routine.run', routineId: randomUUID() }),
    ran: port('routines'),
  },
]

describe('exact per-family capability matrix at queued execution', () => {
  it.each(FAMILIES.map((family) => [family.name, family] as const))(
    '%s runs only while every required capability is still held',
    async (_name, family) => {
      f.command.mockImplementation(async () => f.success)
      for (const dropped of EVERY) {
        const spies = featurePorts()
        f.store.bumpAttention(f.lane.laneId)
        const { held, release } = blocker(family.scope)
        let live: readonly HostCapability[] = EVERY
        const client: LaneCommandClient = { ...f.one, caps: EVERY, currentCaps: () => live }
        const request =
          family.scope === 'lane' ? f.frame(family.op(), fence()) : machine(family.op())
        const queued = f.service.submit(client, request)
        const ran = family.ran(spies)
        live = EVERY.filter((cap) => cap !== dropped)
        release()
        await Promise.all([held, queued])
        const receipt = f.store.getReceipt(request.requestId, client.id)
        if (family.caps.includes(dropped)) {
          expect(receipt, dropped).toEqual(forbidden(request))
          expect(family.ran(spies), dropped).toBe(ran)
        } else {
          expect(receipt?.status, dropped).toBe('done')
          expect(family.ran(spies), dropped).toBeGreaterThan(ran)
        }
      }
    },
  )
})
