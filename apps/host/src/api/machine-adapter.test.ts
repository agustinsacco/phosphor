import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { FrameSocket } from '@phosphor/shared/host-protocol'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import type { LaneService } from '../lanes/service'
import { createAdapterChain } from './adapter'
import type { AuthenticatedFrame, ReadyConnection } from './connection'
import { createLaneAdapter } from './lanes'
import { createMachineAdapter } from './machine-adapter'
import type { ConnectionPrincipal } from './principal'
import { hostLinks } from './server'

const client = { id: randomUUID(), label: 'stark' }
const machineId = randomUUID()
const MACHINE: ConnectionPrincipal = { kind: 'grant-machine', clientId: client.id, machineId }
const ok: OpsRunResult = { status: 'ok', text: 'done', applies: 'now' }
const SURFACE_ONLY = OP_CATALOG.filter((spec) => spec.surfaceOnly === true).map((s) => s.name)

/** A lane service whose every entry point is a spy: what reaches it is what a machine could do. */
function laneService() {
  return {
    epoch: '0123456789abcdef',
    capabilities: ['sessions.read', 'sessions.control', 'terminal'],
    controllerPresence: vi.fn(),
    commands: { submit: vi.fn(async () => {}), status: vi.fn(), capabilityFor: () => null },
    calls: { call: vi.fn(), capabilityFor: () => null },
    terminals: { input: vi.fn(() => true), subscribe: vi.fn(), presence: vi.fn() },
  }
}

function harness(principal?: ConnectionPrincipal, caps: ReadyConnection['caps'] = []) {
  const sent: unknown[] = []
  const socket = {
    isOpen: () => true,
    send: (text: string) => sent.push(JSON.parse(text)),
    onClose: () => {},
    close: () => {},
    bufferedBytes: () => 0,
  } as unknown as FrameSocket
  const service = laneService()
  const run = vi.fn(async () => ok)
  const lanes = createLaneAdapter(service as unknown as LaneService)
  const ready: ReadyConnection = {
    connectionId: 'c1',
    client,
    caps,
    socket,
    ...(principal ? { principal } : {}),
  }
  const handler = createAdapterChain(hostLinks({ dispatcher: { run } }), lanes.handler)(ready)!
  return { handler, sent, service, run, caps }
}

const opsCall = (op: string, id = 'q1') =>
  ({ type: 'call', id, method: 'ops.run', params: { op, args: {} } }) as const
const opsCommand = (op: string) =>
  ({ type: 'command', requestId: randomUUID(), op: { type: 'ops.run', op, args: {} } }) as const
const laneId = randomUUID()
const RAW_FRAMES = [
  { type: 'subscribe', id: 's1', topic: 'lanes' },
  { type: 'subscribe', id: 's2', topic: 'lane', laneId },
  { type: 'subscribe', id: 's3', topic: 'terminal', terminalId: 't' },
  { type: 'command', requestId: randomUUID(), laneId, fence: 1, op: { type: 'prompt', text: 'x' } },
  {
    type: 'command',
    requestId: randomUUID(),
    laneId,
    fence: 1,
    op: { type: 'bash', command: 'id' },
  },
  { type: 'command', requestId: randomUUID(), laneId, op: { type: 'answerDialog', id: 'd' } },
  { type: 'call', id: 'q2', method: 'lane.messages', params: { laneId } },
  { type: 'call', id: 'q3', method: 'artifacts.list', params: {} },
  { type: 'terminal.input', terminalId: 't', seq: 1, data: 'x' },
] as unknown as AuthenticatedFrame[]

describe('machine admission', () => {
  it('refuses prompt, bash, subscribe, lane.messages and terminal input, and runs ops.run', async () => {
    const h = harness(MACHINE)
    for (const frame of RAW_FRAMES) h.handler.handle(frame, [])
    expect(h.sent).toEqual([
      { type: 'subscribe-failed', id: 's1', code: 'forbidden' },
      { type: 'subscribe-failed', id: 's2', code: 'forbidden' },
      { type: 'subscribe-failed', id: 's3', code: 'forbidden' },
      ...RAW_FRAMES.filter((f) => f.type === 'command').map((f) => ({
        type: 'receipt',
        receipt: { requestId: f.requestId, status: 'rejected', code: 'forbidden' },
      })),
      { type: 'result', id: 'q2', ok: false, error: { code: 'forbidden', message: 'forbidden' } },
      { type: 'result', id: 'q3', ok: false, error: { code: 'forbidden', message: 'forbidden' } },
      { type: 'terminal.ack', terminalId: 't', seq: 1, accepted: false },
    ])
    h.handler.handle(opsCall('lane.list', 'q4'), [])
    const write = opsCommand('lane.create')
    h.handler.handle(write, [])
    await vi.waitFor(() => expect(h.sent).toHaveLength(RAW_FRAMES.length + 2))
    const principal = {
      kind: 'machine',
      machineId,
      clientId: client.id,
      label: 'stark',
      lane: null,
    }
    expect(h.run).toHaveBeenCalledWith(principal, { op: 'lane.list', args: {} })
    expect(h.run).toHaveBeenCalledWith(principal, { op: 'lane.create', args: {} })
    expect(h.sent).toContainEqual({ type: 'result', id: 'q4', ok: true, data: ok })
    expect(h.sent).toContainEqual({
      type: 'receipt',
      receipt: { requestId: write.requestId, status: 'done', data: ok },
    })
  })

  it('refuses every surface-only op in band, call and command, before the dispatcher', async () => {
    expect(SURFACE_ONLY).toEqual(expect.arrayContaining(['confirm.approve', 'confirm.deny']))
    const h = harness(MACHINE)
    const denied = {
      status: 'denied',
      code: 'forbidden',
      text: 'Only you can do this, in Phosphor.',
    }
    for (const op of SURFACE_ONLY) {
      h.handler.handle(opsCall(op, op), [])
      const command = opsCommand(op)
      h.handler.handle(command, [])
      expect(h.sent.slice(-2)).toEqual([
        { type: 'result', id: op, ok: true, data: denied },
        {
          type: 'receipt',
          receipt: { requestId: command.requestId, status: 'done', data: denied },
        },
      ])
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.run).not.toHaveBeenCalled()
    h.handler.handle(opsCall('confirm.status'), [])
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
  })

  it('answers receipt-status from the lane service for the machine client only', () => {
    const h = harness(MACHINE)
    const requestId = randomUUID()
    h.handler.handle({ type: 'receipt-status', requestId }, [])
    expect(h.service.commands.status).toHaveBeenCalledExactlyOnceWith(client.id, requestId, 'c1')
  })

  it('moves no controller and no fence: nothing reaches a lane command or call', async () => {
    const h = harness(MACHINE)
    for (const frame of RAW_FRAMES) h.handler.handle(frame, [])
    h.handler.handle(opsCommand('lane.stop'), [])
    h.handler.handle(opsCall('lane.read'), [])
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2))
    h.handler.close()
    expect(h.service.commands.submit).not.toHaveBeenCalled()
    expect(h.service.calls.call).not.toHaveBeenCalled()
    expect(h.service.terminals.input).not.toHaveBeenCalled()
    expect(h.service.terminals.subscribe).not.toHaveBeenCalled()
    for (const [id] of h.service.controllerPresence.mock.calls) expect(id).toBe(client.id)
  })

  it.each<[string, ConnectionPrincipal | undefined]>([
    ['no principal', undefined],
    ['a user grant', { kind: 'grant-user', clientId: client.id }],
    ['the owner', { kind: 'owner', clientId: client.id }],
    ['a local caller', { kind: 'local', clientId: client.id }],
  ])(
    'leaves %s exactly as before: no machine link, ops.run reaches the dispatcher',
    async (_n, p) => {
      const connection = { ...(p ? { principal: p } : {}) } as ReadyConnection
      expect(createMachineAdapter()(connection)).toBeNull()
      const h = harness(p, ['sessions.read', 'sessions.control'])
      h.handler.handle(opsCall('confirm.approve'), [])
      await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
      h.handler.handle({ type: 'call', id: 'q9', method: 'lane.messages', params: {} }, [
        'sessions.read',
      ])
      expect(h.service.calls.call).toHaveBeenCalledOnce()
    },
  )
})
