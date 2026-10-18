import { parseLaneReceipt, receiptSummary } from '@shared/lane-receipt'
import type { LaneReceipt } from '@shared/lane-receipt'
import type { AttentionEvent } from '@shared/host-protocol'
import type { HostAttention } from '@shared/ipc'
import type { AttentionPorts, AttentionState } from './attention'

function canEnrich(event: AttentionEvent): boolean {
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

export function receiptForEvent(event: AttentionEvent, value: unknown): LaneReceipt | null {
  const parsed = parseLaneReceipt(value)
  return canEnrich(event) &&
    parsed &&
    parsed.settledAt !== null &&
    Math.abs(parsed.settledAt - Date.parse(event.at)) <= 30_000 &&
    (event.kind === 'failed') === (parsed.outcome === 'error')
    ? parsed
    : null
}

export function publishAttention(
  state: AttentionState,
  ports: AttentionPorts,
  event: AttentionEvent,
  attention: HostAttention,
  generation: number,
  value?: unknown,
): void {
  if (generation !== state.generation) return
  const { hostId } = attention
  const receipt = receiptForEvent(event, value)
  if (receipt) attention.receipt = receipt
  ports.publish(attention)
  if (!ports.focused(hostId, event.laneId))
    ports.notify(
      `${ports.label(hostId)} · ${attention.title}`,
      receipt
        ? receiptSummary(receipt)
        : attention.kind === 'failed'
          ? 'Stopped'
          : attention.kind === 'finished'
            ? 'Done'
            : attention.kind,
      () => ports.open(hostId, event.laneId),
    )
}

export function waitForReceipt(
  state: AttentionState,
  ports: AttentionPorts,
  event: AttentionEvent,
  attention: HostAttention,
  arrival: number,
): void {
  const { hostId } = attention
  const laneKey = `${hostId}/${event.laneId}`
  const generation = state.generation
  const publish = (value?: unknown) =>
    publishAttention(state, ports, event, attention, generation, value)
  if (!canEnrich(event) || !ports.receipt || ports.focused(hostId, event.laneId)) return publish()
  let request = state.pending.get(laneKey)
  if (!request) {
    if (state.pending.size >= 1600) return publish()
    request = ports.receipt(hostId, event.laneId).catch(() => undefined)
    state.pending.set(laneKey, request)
    void request.finally(() => {
      if (state.pending.get(laneKey) === request) state.pending.delete(laneKey)
    })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  void Promise.race([
    request,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 2000)
    }),
  ])
    .then((value) => {
      if (state.laneArrivals.get(laneKey) === arrival) publish(value)
    })
    .finally(() => clearTimeout(timer))
}
