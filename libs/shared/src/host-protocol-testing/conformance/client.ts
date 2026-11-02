import type { ExpectStatic } from 'vitest'
import { parseHostFrame, type ClientFrame, type HostFrame, type LaneOp } from '../../host-protocol'
import type { GrantPayload } from '../../host-grant'
import type { ConformanceConnection, HostConformanceHarness } from './types'

/** Captured before any test installs fake timers. */
const realSetTimeout = globalThis.setTimeout

export const challenge = 'a'.repeat(64)
export const otherClient = { id: '00000000-0000-4000-8000-000000000002', label: 'Other viewer' }

/** The suite's harness, fake clock and assertions. This module never imports vitest at runtime. */
export interface ClientPorts {
  /** Read on every call, so a helper follows a harness replaced mid-scenario. */
  readonly current: () => HostConformanceHarness
  readonly flush: (ms?: number) => Promise<void>
  readonly expect: ExpectStatic
}
export interface ConformanceViewer extends ConformanceConnection {
  frames: HostFrame[]
  closed: number[]
  send(f: ClientFrame): void
}

export function client({ current }: ClientPorts): ConformanceViewer {
  const connection = current().connect()
  const frames: HostFrame[] = [],
    closed: number[] = []
  connection.socket.onMessage((text) => {
    const p = parseHostFrame(text)
    if (!p.ok) throw new Error('Invalid Host frame: ' + p.reason)
    frames.push(p.value)
  })
  connection.socket.onClose((code) => closed.push(code))
  return {
    ...connection,
    frames,
    closed,
    send(f: ClientFrame) {
      connection.socket.send(JSON.stringify(f))
    },
  }
}
export async function auth(ports: ClientPorts, claims: Partial<GrantPayload> = {}) {
  const { current, flush, expect } = ports
  const c = client(ports)
  c.send({ type: 'auth', grant: current().mintGrant(claims), challenge })
  await flush()
  expect(c.frames[0]?.type).toBe('ready')
  return c
}
export function receipts(c: Pick<ConformanceViewer, 'frames'>, id?: string) {
  return c.frames.flatMap((f) =>
    f.type === 'receipt' && (!id || f.receipt.requestId === id) ? [f.receipt] : [],
  )
}
export async function create(ports: ClientPorts, c: ConformanceViewer) {
  const { flush, expect } = ports
  const h = ports.current()
  let repositoryId = h.repositoryId
  if (repositoryId === undefined) {
    const id = h.requestId()
    c.send({ type: 'call', id, method: 'host.repositories', params: {} })
    await flush()
    const result = c.frames.find((f) => f.type === 'result' && f.id === id)
    if (!result || result.type !== 'result' || !result.ok || !Array.isArray(result.data))
      throw new Error('Missing repositories')
    const first: unknown = result.data[0]
    if (!first || typeof first !== 'object' || !('id' in first) || typeof first.id !== 'string')
      throw new Error('Missing repository id')
    repositoryId = first.id
  }
  const id = h.requestId()
  c.send({
    type: 'command',
    requestId: id,
    op: { type: 'lane.create', repositoryId, worktree: null },
  })
  await flush(5)
  // A Host may report the creation's phases on pending receipts first.
  const r = receipts(c, id).find((receipt) => receipt.status !== 'pending')
  expect(r?.status).toBe('done')
  if (!r || r.status !== 'done' || !r.laneId) throw new Error('No created lane')
  return r.laneId
}
export async function command(
  ports: ClientPorts,
  c: ConformanceViewer,
  laneId: string,
  op: LaneOp,
  fence = 1,
) {
  const { flush } = ports
  const requestId = ports.current().requestId()
  c.send({ type: 'command', requestId, laneId, fence, op })
  await flush(5)
  // Some Host commands touch the real filesystem (Stop checks pi's session file), which
  // fake timers do not advance. Yield real event-loop turns without moving fake time.
  for (let i = 0; i < 100 && !receipts(c, requestId).length; i++) {
    await new Promise((resolve) => realSetTimeout(resolve, 1))
    await flush()
  }
  const r = receipts(c, requestId).at(-1)
  if (!r) throw new Error('Missing receipt')
  return r
}
export function events(c: Pick<ConformanceViewer, 'frames'>, id = 'lane') {
  return c.frames.filter(
    (f): f is Extract<HostFrame, { type: 'event' }> => f.type === 'event' && f.id === id,
  )
}
export function snapshots(c: Pick<ConformanceViewer, 'frames'>) {
  return c.frames.filter(
    (f): f is Extract<HostFrame, { type: 'snapshot' }> => f.type === 'snapshot',
  )
}
