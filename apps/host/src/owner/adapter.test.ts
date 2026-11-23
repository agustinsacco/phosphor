import { createWorkspaceLeases, leaseHandlers } from './lease'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { FrameSocket } from '@phosphor/shared/host-protocol'
import { OWNER_METHODS, OWNER_METHODS_ANY_LOCAL } from '@phosphor/shared/host-protocol-owner'
import type { ReadyConnection } from '../api/connection'
import type { ConnectionPrincipal } from '../api/principal'
import { createOwnerAdapter, OwnerCallRefused, type OwnerHandlers } from './adapter'

const client = { id: randomUUID(), label: 'Desktop' }
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
const call = (method: string, params?: unknown) =>
  ({ type: 'call', id: 'q', method, params }) as const
const status = { machineId: randomUUID(), hostVersion: '1.0.0', mode: 'local' as const }

describe('the owner adapter', () => {
  it('never answers a grant connection, so owner methods reach the lane adapter as on older Hosts', () => {
    const handlers: OwnerHandlers = { 'machine.local': vi.fn(async () => status) }
    for (const principal of [
      undefined,
      { kind: 'grant-user', clientId: client.id },
      { kind: 'grant-machine', clientId: client.id, machineId: randomUUID() },
    ] as const)
      expect(createOwnerAdapter(handlers)(connection(principal).ready)).toBeNull()
  })

  it('runs a handler with the principal and answers its result; unsupported without one', async () => {
    const local = vi.fn(async () => status)
    const { ready, sent } = connection({ kind: 'owner', clientId: client.id })
    const link = createOwnerAdapter({ 'machine.local': local })(ready)!
    expect(link.handle(call('machine.local'), [])).toBe(true)
    expect(link.handle(call('owner.index', {}), [])).toBe(true)
    expect(link.handle(call('lane.state', {}), [])).toBe(false)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent).toContainEqual({ type: 'result', id: 'q', ok: true, data: status })
    expect(sent).toContainEqual({
      type: 'result',
      id: 'q',
      ok: false,
      error: { code: 'unsupported', message: 'unsupported' },
    })
    expect(local).toHaveBeenCalledWith(undefined, {
      principal: { kind: 'owner', clientId: client.id },
      client,
      connectionId: 'c',
      signal: expect.any(AbortSignal),
    })
  })

  it('answers bad-request for invalid params, a refusal with its code and any other throw as internal', async () => {
    const { ready, sent } = connection({ kind: 'owner', clientId: client.id })
    const link = createOwnerAdapter({
      'machine.enroll': async () => {
        throw new OwnerCallRefused('forbidden', 'Enrollment refused: standby.')
      },
      'machine.owner': async () => {
        throw new Error('private detail')
      },
    })(ready)!
    link.handle(call('machine.enroll', { action: 'steal' }), [])
    link.handle(call('machine.enroll', { action: 'begin' }), [])
    link.handle(call('machine.owner', { action: 'acquire' }), [])
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    expect(sent.map((f) => (f as { error: unknown }).error)).toEqual([
      { code: 'bad-request', message: 'bad-request' },
      { code: 'forbidden', message: 'Enrollment refused: standby.' },
      { code: 'internal', message: 'internal' },
    ])
  })

  it('gives a local principal only the methods open to every local caller', async () => {
    const handlers = Object.fromEntries(
      OWNER_METHODS.map((m) => [m, vi.fn(async () => ({}))]),
    ) as OwnerHandlers
    const { ready, sent } = connection({ kind: 'local', clientId: client.id })
    const link = createOwnerAdapter(handlers)(ready)!
    for (const method of OWNER_METHODS) link.handle({ ...call(method), id: method }, [])
    await vi.waitFor(() => expect(sent).toHaveLength(OWNER_METHODS.length))
    const answered = sent as { id: string; ok: boolean; error?: { code: string } }[]
    for (const method of OWNER_METHODS) {
      const frame = answered.find((f) => f.id === method)
      const open = (OWNER_METHODS_ANY_LOCAL as readonly string[]).includes(method)
      if (open) expect(frame).toMatchObject({ ok: true })
      else expect(frame).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
  })
})

it('the installed lease handlers read the active domain for each call on one link', async () => {
  const { ready, sent } = connection({ kind: 'owner', clientId: client.id })
  let active: ReturnType<typeof createWorkspaceLeases> | undefined
  const link = createOwnerAdapter(leaseHandlers(() => active))(ready)!
  const renew = call('owner.lease.renew', { leaseId: randomUUID() })
  link.handle(renew, [])
  await vi.waitFor(() =>
    expect(sent[0]).toMatchObject({
      ok: false,
      error: { code: 'forbidden', message: "Lanes on this Mac aren't running yet." },
    }),
  )
  active = createWorkspaceLeases(() => [])
  link.handle(renew, [])
  await vi.waitFor(() => expect(sent[1]).toMatchObject({ ok: true, data: { ok: false } }))
})
