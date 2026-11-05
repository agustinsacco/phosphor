import { receiptExpected, receiptForEvent, receiptWithin } from '@phosphor/host-client/attention'
import { receiptSummary } from '@shared/lane-receipt'
import type { AttentionEvent } from '@shared/host-protocol'
import type { HostAttention } from '@shared/ipc'
import type { AttentionPorts, AttentionState } from './attention'

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
  if (!receiptExpected(event) || !ports.receipt || ports.focused(hostId, event.laneId))
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
