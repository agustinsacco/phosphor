import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { FrameSocket } from '@phosphor/shared/host-protocol'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { createOpsAdapter, createOpsQueue } from '../ops/adapter'
import { createOwnerAdapter } from '../owner/adapter'
import { createAdapterChain } from './adapter'
import type { AuthenticatedHandler, ReadyConnection } from './connection'
import { createMachineAdapter } from './machine-adapter'
import type { ConnectionPrincipal } from './principal'

const client = { id: randomUUID(), label: 'Laptop' }
function connection(principal?: ConnectionPrincipal) {
  const sent: unknown[] = []
  const socket = {
    isOpen: () => true,
    send: (text: string) => sent.push(JSON.parse(text)),
  } as unknown as FrameSocket
  const ready: ReadyConnection = {
    connectionId: 'c',
    client,
    caps: [],
    socket,
    ...(principal ? { principal } : {}),
  }
  return { ready, sent }
}
function lanes() {
  const inner: AuthenticatedHandler = { handle: vi.fn(), renew: vi.fn(), close: vi.fn() }
  return { inner, factory: vi.fn(() => inner) }
}
const links = (dispatcher?: { run: (...args: never[]) => Promise<OpsRunResult> }) => [
  createOwnerAdapter(),
  createOpsAdapter(dispatcher ? { dispatcher } : {}),
  createMachineAdapter(),
]
const ok: OpsRunResult = { status: 'ok', text: 'done', applies: 'now' }
const call = (method: string, params?: unknown) =>
  ({ type: 'call', id: 'q1', method, params }) as const
const opsCommand = {
  type: 'command',
  requestId: randomUUID(),
  op: { type: 'ops.run', op: 'lane.list', args: {} },
} as const

describe('adapter chain', () => {
  it('hands a user grant connection the lane adapter handler itself', () => {
    const { inner, factory } = lanes()
    const { ready } = connection()
    expect(createAdapterChain(links(), factory)(ready)).toBe(inner)
    expect(createAdapterChain(links(), undefined)(ready)).toBeUndefined()
    const user = connection({ kind: 'grant-user', clientId: client.id })
    expect(createAdapterChain(links(), factory)(user.ready)).toBe(inner)
  })

  it('answers owner methods for socket principals only and passes the rest on', () => {
    const { inner, factory } = lanes()
    const owner = connection({ kind: 'owner', clientId: client.id })
    const handler = createAdapterChain(links(), factory)(owner.ready)!
    handler.handle(call('owner.index', {}), [])
    handler.handle(call('artifacts.list', {}), [])
    expect(owner.sent).toEqual([
      {
        type: 'result',
        id: 'q1',
        ok: false,
        error: { code: 'unsupported', message: 'unsupported' },
      },
    ])
    expect(inner.handle).toHaveBeenCalledWith(call('artifacts.list', {}), [])
    const local = connection({ kind: 'local', clientId: client.id })
    const localHandler = createAdapterChain(links(), undefined)(local.ready)!
    localHandler.handle(call('owner.index', {}), [])
    localHandler.handle(call('machine.local'), [])
    localHandler.handle(call('artifacts.list', {}), [])
    expect(local.sent.map((f) => (f as { error: { code: string } }).error.code)).toEqual([
      'forbidden',
      'unsupported',
      'unsupported',
    ])
    handler.renew([])
    handler.close()
    expect(inner.renew).toHaveBeenCalledOnce()
    expect(inner.close).toHaveBeenCalledOnce()
  })

  it('refuses everything but ops.run from another machine before the lane adapter', () => {
    const { inner, factory } = lanes()
    const m = connection({ kind: 'grant-machine', clientId: client.id, machineId: randomUUID() })
    const handler = createAdapterChain(links(), factory)(m.ready)!
    handler.handle({ type: 'subscribe', id: 's', topic: 'lanes' } as never, [])
    handler.handle(call('artifacts.list'), [])
    handler.handle(opsCommand, [])
    handler.handle({ type: 'terminal.input', terminalId: 't', seq: 1, data: 'x' } as never, [])
    expect(inner.handle).not.toHaveBeenCalled()
    expect(m.sent).toEqual([
      { type: 'subscribe-failed', id: 's', code: 'forbidden' },
      { type: 'result', id: 'q1', ok: false, error: { code: 'forbidden', message: 'forbidden' } },
      {
        type: 'receipt',
        receipt: { requestId: opsCommand.requestId, status: 'rejected', code: 'forbidden' },
      },
      { type: 'terminal.ack', terminalId: 't', seq: 1, accepted: false },
    ])
  })

  it('runs ops.run calls and commands through a bound dispatcher as the connection principal', async () => {
    const run = vi.fn(async () => ok)
    const { inner, factory } = lanes()
    const machineId = randomUUID()
    const m = connection({ kind: 'grant-machine', clientId: client.id, machineId })
    const handler = createAdapterChain(links({ run }), factory)(m.ready)!
    handler.handle(
      call('ops.run', { op: 'lane.list', args: {}, actor: { kind: 'agent', lane: 'x' } }),
      [],
    )
    handler.handle(opsCommand, [])
    handler.handle(call('ops.run', { op: 'Bad Name', args: {} }), [])
    await vi.waitFor(() => expect(m.sent).toHaveLength(3))
    expect(inner.handle).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledWith(
      { kind: 'machine', machineId, clientId: client.id, label: 'Laptop', lane: 'x' },
      { op: 'lane.list', args: {}, actor: { kind: 'agent', lane: 'x' } },
    )
    expect(m.sent).toContainEqual({ type: 'result', id: 'q1', ok: true, data: ok })
    expect(m.sent).toContainEqual({
      type: 'receipt',
      receipt: { requestId: opsCommand.requestId, status: 'done', data: ok },
    })
    expect(m.sent).toContainEqual({
      type: 'result',
      id: 'q1',
      ok: false,
      error: { code: 'bad-request', message: 'bad-request' },
    })
  })

  it('says unknown or internal when the dispatcher fails, and nothing after close', async () => {
    const run = vi.fn(async () => Promise.reject(new Error('down')))
    const user = connection({ kind: 'grant-user', clientId: client.id })
    const handler = createAdapterChain(links({ run }), undefined)(user.ready)!
    handler.handle(opsCommand, [])
    handler.handle(call('ops.run', { op: 'lane.list', args: {} }), [])
    await vi.waitFor(() => expect(user.sent).toHaveLength(2))
    expect(user.sent).toContainEqual({
      type: 'receipt',
      receipt: { requestId: opsCommand.requestId, status: 'unknown' },
    })
    expect(user.sent).toContainEqual({
      type: 'result',
      id: 'q1',
      ok: false,
      error: { code: 'internal', message: 'internal' },
    })
    handler.close()
    handler.handle(opsCommand, [])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(user.sent).toHaveLength(2)
  })
})

describe('ops queue', () => {
  it('runs one principal in order, other principals and service ops beside it', async () => {
    const queue = createOpsQueue()
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const first = queue.run('a', 'control', async () => {
      await held
      order.push('a1')
    })
    const second = queue.run('a', 'control', async () => {
      order.push('a2')
    })
    await queue.run('b', 'control', async () => {
      order.push('b1')
    })
    await queue.run('a', 'service', async () => {
      order.push('brain')
    })
    expect(order).toEqual(['b1', 'brain'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['b1', 'brain', 'a1', 'a2'])
    await expect(
      queue.run('a', 'control', async () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x')
    await expect(queue.run('a', 'control', async () => 'after')).resolves.toBe('after')
  })
})
