import type { AttentionEvent } from '@shared/host-protocol'
import type { HostAttention } from '@shared/ipc'
import { makeAttention, waitForReceipt } from './attention-publication'

export interface AttentionPorts {
  receipt?: (hostId: string, laneId: string) => Promise<unknown>
  label: (hostId: string) => string
  focused: (hostId: string, laneId: string) => boolean
  publish: (event: HostAttention) => void
  notify: (title: string, body: string, click: () => void) => void
  open: (hostId: string, laneId: string) => void
}

export interface AttentionState {
  seen: Set<string>
  pending: Map<string, Promise<unknown>>
  laneArrivals: Map<string, number>
  // Unique counters prevent an evicted lane's old publication from becoming current again.
  arrivalCounter: number
  generation: number
}

export function createHostAttention(ports: AttentionPorts) {
  const state: AttentionState = {
    seen: new Set(),
    pending: new Map(),
    laneArrivals: new Map(),
    arrivalCounter: 0,
    generation: 0,
  }
  return {
    clear: () => clearAttention(state),
    receive: (hostId: string, event: AttentionEvent) =>
      receiveAttention(state, ports, hostId, event),
  }
}

function clearAttention(state: AttentionState): void {
  state.generation++
  state.seen.clear()
  state.pending.clear()
  state.laneArrivals.clear()
}

function receiveAttention(
  state: AttentionState,
  ports: AttentionPorts,
  hostId: string,
  event: AttentionEvent,
): void {
  const key = `${hostId}/${event.id}`
  if (state.seen.has(key)) return
  state.seen.add(key)
  const laneKey = `${hostId}/${event.laneId}`
  const arrival = ++state.arrivalCounter
  state.laneArrivals.delete(laneKey)
  state.laneArrivals.set(laneKey, arrival)
  if (state.laneArrivals.size > 256) {
    const oldest = state.laneArrivals.keys().next().value
    if (oldest) state.laneArrivals.delete(oldest)
  }
  if (state.seen.size > 1600) {
    const oldest = state.seen.values().next().value
    if (oldest) state.seen.delete(oldest)
  }
  waitForReceipt(state, ports, event, makeAttention(hostId, event), arrival)
}

/** Only the connection that began this read may supply the receipt. */
export async function readHostReceipt(
  connectionFor: (hostId: string) =>
    | {
        snapshot(): {
          state: string
          capabilities: readonly string[]
          lanes: readonly { laneId: string }[]
        }
        call(method: string, params: unknown): Promise<{ ok: true; data?: unknown } | { ok: false }>
      }
    | undefined,
  hostId: string,
  laneId: string,
): Promise<unknown> {
  const connection = connectionFor(hostId)
  if (!connection?.snapshot().capabilities.includes('sessions.read')) return undefined
  const data = await connection.call('lane.receipt', { laneId })
  const view = connection.snapshot()
  if (
    connectionFor(hostId) !== connection ||
    view.state !== 'ready' ||
    !view.capabilities.includes('sessions.read') ||
    !view.lanes.some((lane) => lane.laneId === laneId)
  )
    return undefined
  return data.ok ? data.data : undefined
}
