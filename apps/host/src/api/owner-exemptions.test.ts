import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ATTACHMENT_LIMITS } from '@phosphor/shared/host-protocol-attachments'
import {
  HOST_LIMITS,
  type FrameSocket,
  type HostFrame,
  type LaneOp,
} from '@phosphor/shared/host-protocol'
import { TERMINAL_LIMITS } from '@phosphor/shared/host-protocol-terminals'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { createAttachments } from '../features/attachments'
import { createCommandsFixture, type CommandsFixture } from '../lanes/__fixtures__/commands.fixture'
import { createLaneCommands, type LaneCommandPorts } from '../lanes/commands'
import type { LaneService } from '../lanes/service'
import { createTerminals } from '../terminals/service'
import { createLaneAdapter } from './lanes'
import type { ConnectionPrincipal } from './principal'

/**
 * One contract test per owner exemption (reconcile-v1 B9): the attested owner
 * on the local socket gets it, and a TCP grant connection, user or machine,
 * keeps the limit. Every case runs the real lane adapter, lane commands,
 * terminal service and attachment service; only pi and the PTY are fakes.
 */
const GRANTS = ['grant-user', 'grant-machine'] as const
type Kind = (typeof GRANTS)[number] | 'owner'
const CAPS: readonly HostCapability[] = ['sessions.control', 'terminal', 'workspaces.write']

function principal(kind: Kind, clientId: string): ConnectionPrincipal {
  return kind === 'grant-machine' ? { kind, clientId, machineId: randomUUID() } : { kind, clientId }
}

const opened: { close(): void }[] = []
afterEach(() => {
  for (const item of opened.splice(0)) item.close()
  vi.useRealTimers()
})

/** The lane's real terminal, attachment and command services; receipts go through `deliver`. */
function hostServices(f: CommandsFixture, deliver: LaneCommandPorts['deliver']): LaneService {
  const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
  const terminals = createTerminals({
    native: { spawn: () => pty },
    context: { store: f.store, env: {}, home: f.root, log() {} },
    env: { PATH: '/usr/bin:/bin' },
    epoch: 'a'.repeat(16),
    now: () => 0,
    shell: () => '/bin/sh',
    load: () => [],
    save() {},
  })
  mkdirSync(join(f.root, 'attachments-state'))
  const attachments = createAttachments({
    directory: realpathSync(join(f.root, 'attachments-state')),
    laneExists: () => true,
  })
  opened.push({
    close() {
      terminals.close()
      attachments.close()
      f.cleanup()
    },
  })
  return {
    terminals,
    epoch: 'e',
    capabilities: CAPS,
    commands: createLaneCommands({ ...f.ports, terminals, attachments, deliver }),
    calls: { call: vi.fn(), capabilityFor: () => null },
    streams: {},
    lanesTopic: {},
    controllerPresence: () => {},
  } as unknown as LaneService
}

/** A socket that records the frames sent to it; `drop` closes it from the client side. */
function fakeSocket() {
  const frames: HostFrame[] = []
  const closers: (() => void)[] = []
  let open = true
  const socket: FrameSocket = {
    send: (text) => void frames.push(JSON.parse(text) as HostFrame),
    close: () => {
      open = false
    },
    onMessage: () => {},
    onClose: (cb) => void closers.push(() => cb(1000, '')),
    isOpen: () => open,
    bufferedBytes: () => 0,
  }
  const drop = () => {
    open = false
    for (const cb of closers) cb()
  }
  return { socket, frames, drop }
}

/** One lane, its Host services and one connection of `kind` on the shared lane adapter. */
async function host(kind: Kind) {
  const f: CommandsFixture = await createCommandsFixture()
  // Receipts reach the connection through the adapter, as in production, which frees its slots.
  let adapter: ReturnType<typeof createLaneAdapter> | undefined
  const service = hostServices(f, (clientId, receipt, connectionId) => {
    f.ports.deliver(clientId, receipt, connectionId)
    adapter?.deliver(clientId, receipt, connectionId)
  })
  const { socket, frames, drop } = fakeSocket()
  const client = { id: f.one.id, label: f.one.label }
  adapter = createLaneAdapter(service)
  const handler = adapter.handler({
    connectionId: randomUUID(),
    client,
    principal: principal(kind, client.id),
    caps: CAPS,
    socket,
  })
  const laneId = f.lane.laneId
  const fence = () => f.store.getLane(laneId)?.control.fence ?? 1
  /** Sends a command and returns its id at once, for answers that are still owed. */
  const submit = (op: LaneOp | Record<string, unknown>, lane = true) => {
    const requestId = randomUUID()
    const target = lane ? { laneId, fence: fence() } : {}
    handler.handle({ type: 'command', requestId, ...target, op } as never, CAPS)
    return requestId
  }
  /** Sends a command (with no lane: a machine one) and waits until it is not pending. */
  const command = async (op: LaneOp | Record<string, unknown>, lane = true) => {
    const requestId = submit(op, lane)
    await vi.waitFor(() => expect(f.last(requestId)?.status ?? 'pending').not.toBe('pending'))
    return f.last(requestId)
  }
  const input = (terminalId: string, seq: number, data: string) => {
    handler.handle({ type: 'terminal.input', terminalId, seq, data } as never, CAPS)
    const ack = frames.at(-1)
    return ack?.type === 'terminal.ack' && ack.accepted
  }
  /** The connection closes, as when Desktop quits or its socket drops. */
  return { f, submit, command, input, disconnect: drop }
}

const create = { type: 'terminal.create', cols: 80, rows: 24 } as const

async function openShells(h: Awaited<ReturnType<typeof host>>, count: number) {
  const statuses: string[] = []
  for (let i = 0; i < count; i++) statuses.push((await h.command(create))?.status ?? 'none')
  return statuses
}

describe('terminal per-lane cap', () => {
  it.each(GRANTS)('a %s connection keeps the cap of eight', async (kind) => {
    const h = await host(kind)
    const statuses = await openShells(h, TERMINAL_LIMITS.perLane + 1)
    expect(statuses.slice(0, TERMINAL_LIMITS.perLane).every((s) => s === 'done')).toBe(true)
    expect(statuses.at(-1)).toBe('unknown')
  })

  it('the owner opens more than eight shells in one lane, up to the per-Host 32', async () => {
    const h = await host('owner')
    const statuses = await openShells(h, TERMINAL_LIMITS.perHost + 1)
    expect(statuses.slice(0, TERMINAL_LIMITS.perHost).every((s) => s === 'done')).toBe(true)
    // The frozen terminal.list parser reads at most 32 rows, so the per-Host cap stays.
    expect(statuses.at(-1)).toBe('unknown')
  })
})

describe('machine shells, which share the per-lane cap as one scope', () => {
  const openMachineShells = async (h: Awaited<ReturnType<typeof host>>) => {
    const statuses: string[] = []
    for (let i = 0; i <= TERMINAL_LIMITS.perLane; i++)
      statuses.push((await h.command(create, false))?.status ?? 'none')
    return statuses
  }

  it.each(GRANTS)('a %s connection keeps the cap of eight', async (kind) => {
    const statuses = await openMachineShells(await host(kind))
    expect(statuses.slice(0, -1).every((s) => s === 'done')).toBe(true)
    expect(statuses.at(-1)).toBe('unknown')
  })

  it('the owner opens a ninth', async () => {
    expect((await openMachineShells(await host('owner'))).every((s) => s === 'done')).toBe(true)
  })
})

/** Types `TERMINAL_LIMITS.inputBytesPerSecond` and one more frame inside one second. */
async function typeFastInto(h: Awaited<ReturnType<typeof host>>) {
  const receipt = await h.command(create)
  const terminalId = (receipt as { data: { terminalId: string } }).data.terminalId
  const data = 'x'.repeat(TERMINAL_LIMITS.inputBytes)
  const frames = TERMINAL_LIMITS.inputBytesPerSecond / TERMINAL_LIMITS.inputBytes + 1
  return Array.from({ length: frames }, (_, i) => h.input(terminalId, i + 1, data))
}

describe('terminal input throttle', () => {
  it.each(GRANTS)('a %s connection is held to 64 KiB/s', async (kind) => {
    const accepted = await typeFastInto(await host(kind))
    expect(accepted.slice(0, -1).every(Boolean)).toBe(true)
    expect(accepted.at(-1)).toBe(false)
  })

  it('the owner types without a throttle', async () => {
    expect((await typeFastInto(await host('owner'))).every(Boolean)).toBe(true)
  })
})

/** Begins uploads of the largest file until one past the hourly quota. */
async function beginPastQuota(h: Awaited<ReturnType<typeof host>>) {
  const begins = Math.floor(ATTACHMENT_LIMITS.hourlyBytes / ATTACHMENT_LIMITS.fileBytes) + 1
  const statuses: string[] = []
  for (let i = 0; i < begins; i++) {
    const op = {
      type: 'attachments.begin',
      name: `scan-${i}.pdf`,
      size: ATTACHMENT_LIMITS.fileBytes,
      mime: 'application/pdf',
    }
    statuses.push((await h.command(op))?.status ?? 'none')
  }
  return statuses
}

describe('attachment hourly quota', () => {
  it.each(GRANTS)('a %s connection is charged and refused past the hour', async (kind) => {
    const statuses = await beginPastQuota(await host(kind))
    expect(statuses.slice(0, -1).every((s) => s === 'done')).toBe(true)
    expect(statuses.at(-1)).toBe('rejected')
  })

  it('the owner is not charged', async () => {
    expect((await beginPastQuota(await host('owner'))).every((s) => s === 'done')).toBe(true)
  })
})

const LONG_OPS: LaneOp[] = [{ type: 'bash', command: 'sleep 60' }, { type: 'compact' }]

describe('answer deadline for bash and compact', () => {
  it.each(GRANTS.flatMap((kind) => LONG_OPS.map((op) => [kind, op] as const)))(
    'a %s connection reads unknown after 30 s: %o',
    async (kind, op) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const h = await host(kind)
      const requestId = h.submit(op)
      await vi.waitFor(() => expect(h.f.pending).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
      expect(h.f.last(requestId)?.status).toBe('unknown')
    },
  )

  it.each(LONG_OPS)('the owner waits past 30 s for pi to answer: %o', async (op) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await host('owner')
    const requestId = h.submit(op)
    await vi.waitFor(() => expect(h.f.pending).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(10 * HOST_LIMITS.commandAnswerMs)
    expect(h.f.last(requestId)).toBeUndefined()
    expect(h.f.store.getReceipt(requestId, h.f.one.id)?.status).toBe('pending')
    h.f.finish(0)
    await vi.waitFor(() => expect(h.f.last(requestId)?.status).toBe('done'))
  })

  it('the owner gets no longer deadline for other pi commands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await host('owner')
    const requestId = h.submit({ type: 'prompt', message: 'hi' })
    await vi.waitFor(() => expect(h.f.pending).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    expect(h.f.last(requestId)?.status).toBe('unknown')
  })

  it('settles unknown when pi exits or the lane stops: the runtime request fails', async () => {
    const h = await host('owner')
    const requestId = h.submit({ type: 'bash', command: 'sleep 60' })
    await vi.waitFor(() => expect(h.f.pending).toHaveLength(1))
    // Stopping a lane ends its pi process; the RPC client fails every pending request on exit.
    h.f.pending[0]?.reject(new Error('pi exited (code=null, signal=SIGTERM)'))
    await vi.waitFor(() => expect(h.f.last(requestId)?.status).toBe('unknown'))
  })

  it('settles unknown when the owner connection that sent it closes', async () => {
    const h = await host('owner')
    const requestId = h.submit({ type: 'compact' })
    await vi.waitFor(() => expect(h.f.pending).toHaveLength(1))
    h.disconnect()
    await vi.waitFor(() => expect(h.f.last(requestId)?.status).toBe('unknown'))
    // pi's late answer is logged, never a second receipt.
    h.f.finish(0)
    await vi.waitFor(() => expect(h.f.logs.map((l) => l.message)).toContain('lane.command_late'))
    expect(h.f.receipts(requestId).map((r) => r.status)).toEqual(['unknown'])
  })
})
