import { parseLaneReceipt, type LaneReceipt } from '@phosphor/shared/lane-receipt'
import type { AttentionEvent } from '@phosphor/shared/host-protocol'
import type { HostAttention } from '@phosphor/shared/ipc'

/** Only a settled run or a finished routine has a receipt worth waiting for. */
export function receiptExpected(event: AttentionEvent): boolean {
  return event.kind === 'finished' || event.kind === 'failed' || event.kind === 'routine-finished'
}

export function makeAttention(hostId: string, event: AttentionEvent): HostAttention {
  const kind = event.kind.startsWith('routine-') ? 'routine' : event.kind
  return {
    hostId,
    laneId: event.laneId,
    kind: kind === 'finished' || kind === 'needs-input' || kind === 'failed' ? kind : 'routine',
    title: event.title ?? 'Untitled lane',
    at: event.at,
  }
}

/** The receipt of the run this event announces: settled within 30s of it, with a matching outcome. */
export function receiptForEvent(event: AttentionEvent, value: unknown): LaneReceipt | null {
  const parsed = parseLaneReceipt(value)
  return receiptExpected(event) &&
    parsed &&
    parsed.settledAt !== null &&
    Math.abs(parsed.settledAt - Date.parse(event.at)) <= 30_000 &&
    (event.kind === 'failed') === (parsed.outcome === 'error')
    ? parsed
    : null
}

/** A receipt read that has not answered in two seconds is not waited for. */
export function receiptWithin(request: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    request,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 2000)
    }),
  ]).finally(() => clearTimeout(timer))
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

export interface AttentionReceiverPorts {
  /** The lane's receipt read; without one, every attention publishes at once. */
  receipt?: (hostId: string, laneId: string) => Promise<unknown>
  /** A lane in view publishes at once, without waiting for its receipt. */
  focused?: (hostId: string, laneId: string) => boolean
  /** The attention, carrying its run's receipt when one matched. */
  publish: (attention: HostAttention) => void
}

interface AttentionState {
  seen: Set<string>
  pending: Map<string, Promise<unknown>>
  laneArrivals: Map<string, number>
  // Unique counters prevent an evicted lane's old publication from becoming current again.
  arrivalCounter: number
  generation: number
}

/**
 * A Host's attention events, each published once, worded from its run's receipt when one answers
 * within two seconds. A newer attention for the lane supersedes one still waiting, one read per
 * lane serves every event waiting on it, and `clear` (an account change) drops every wait.
 */
export function createAttentionReceiver(ports: AttentionReceiverPorts) {
  const state: AttentionState = {
    seen: new Set(),
    pending: new Map(),
    laneArrivals: new Map(),
    arrivalCounter: 0,
    generation: 0,
  }
  return {
    clear() {
      state.generation++
      state.seen.clear()
      state.pending.clear()
      state.laneArrivals.clear()
    },
    receive: (hostId: string, event: AttentionEvent) =>
      receiveAttention(state, ports, hostId, event),
  }
}

function receiveAttention(
  state: AttentionState,
  ports: AttentionReceiverPorts,
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
  waitForReceipt(state, ports, hostId, event, arrival)
}

function waitForReceipt(
  state: AttentionState,
  ports: AttentionReceiverPorts,
  hostId: string,
  event: AttentionEvent,
  arrival: number,
): void {
  const laneKey = `${hostId}/${event.laneId}`
  const generation = state.generation
  const publish = (value?: unknown) => {
    if (generation !== state.generation) return
    const attention = makeAttention(hostId, event),
      receipt = receiptForEvent(event, value)
    ports.publish(receipt ? { ...attention, receipt } : attention)
  }
  if (!receiptExpected(event) || !ports.receipt || ports.focused?.(hostId, event.laneId))
    return publish()
  let request = state.pending.get(laneKey)
  if (!request) {
    if (state.pending.size >= 1600) return publish()
    request = ports.receipt(hostId, event.laneId).catch(() => undefined)
    state.pending.set(laneKey, request)
    void request.finally(() => {
      if (state.pending.get(laneKey) === request) state.pending.delete(laneKey)
    })
  }
  void receiptWithin(request).then((value) => {
    if (state.laneArrivals.get(laneKey) === arrival) publish(value)
  })
}
