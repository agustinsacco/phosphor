import type { PiEvent } from '@phosphor/shared/rpc'
import type { PendingList, ProjectionState } from './projection-state'

/**
 * A projection's pending events (`tail`, or `barrier` while one holds) and their running
 * UTF-8 size as `JSON.stringify` encodes them. Each event is measured once, when it enters
 * pending, so the replay bound costs O(event) per event, not O(pending bytes).
 *
 * A merged delta is sized as the new event plus the earlier text it extends. That is exact
 * except for a surrogate pair split across two deltas: it counts two 6-byte escapes for one
 * 4-byte character, so the size runs over by 8 bytes per split pair and never under.
 */
export interface PendingSizes {
  /** JSON bytes of each event. */
  event: WeakMap<PiEvent, number>
  /** JSON-escaped bytes of a merged delta's text, without its quotes. */
  text: WeakMap<PiEvent, number>
}

export function createPendingSizes(): PendingSizes {
  return { event: new WeakMap(), text: new WeakMap() }
}

// JSON.stringify escapes lone surrogates, so its output always encodes losslessly.
const encoder = new TextEncoder()
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length
const textBytes = (text: string) => jsonBytes(text) - 2

export function eventBytes(sizes: PendingSizes, event: PiEvent): number {
  let bytes = sizes.event.get(event)
  if (bytes === undefined) {
    bytes = jsonBytes(event)
    sizes.event.set(event, bytes)
  }
  return bytes
}

/** Sizes `merged`, which is `event` with the delta text of `last` before its own. */
function mergedDeltaBytes(
  sizes: PendingSizes,
  merged: PiEvent,
  event: PiEvent,
  last: PiEvent,
  texts: { last: string; event: string },
): number {
  const earlier = sizes.text.get(last) ?? textBytes(texts.last)
  sizes.text.set(merged, earlier + textBytes(texts.event))
  const bytes = eventBytes(sizes, event) + earlier
  sizes.event.set(merged, bytes)
  return bytes
}

export function listBytes(sizes: PendingSizes, events: readonly PiEvent[]): number {
  let bytes = 0
  for (const event of events) bytes += eventBytes(sizes, event)
  return bytes
}

/** UTF-8 bytes of `JSON.stringify` of an array of `count` events summing to `bytes`. */
export function arrayBytes(count: number, bytes: number): number {
  return count === 0 ? 2 : bytes + count + 1
}

export function runEvents(state: ProjectionState): PiEvent[] {
  return [state.run, state.queue, state.retry, state.compaction].filter((e) => e !== undefined)
}

export function pending(state: ProjectionState): PiEvent[] {
  return (
    state.barrier ??
    [...runEvents(state), ...state.tail].sort(
      (a, b) => (state.order.get(a) ?? 0) - (state.order.get(b) ?? 0),
    )
  )
}

export function setTail(state: ProjectionState, events: PiEvent[]) {
  state.tail = events
  state.bytes.tail = listBytes(state.sizes, events)
}

export function setBarrier(state: ProjectionState, events: PiEvent[] | undefined) {
  state.barrier = events
  state.bytes.barrier = events ? listBytes(state.sizes, events) : 0
}

export function appendEvent(
  state: ProjectionState,
  list: PendingList,
  events: PiEvent[],
  event: PiEvent,
): PiEvent[] {
  if (event.type === 'message_update') {
    const delta = event.assistantMessageEvent
    const last = events.at(-1)
    if (
      (delta.type === 'text_delta' ||
        delta.type === 'thinking_delta' ||
        delta.type === 'toolcall_delta') &&
      last?.type === 'message_update' &&
      last.assistantMessageEvent.type === delta.type &&
      last.assistantMessageEvent.contentIndex === delta.contentIndex
    ) {
      const merged: PiEvent = {
        ...event,
        assistantMessageEvent: { ...delta, delta: last.assistantMessageEvent.delta + delta.delta },
      }
      state.order.set(merged, state.sequence)
      const texts = { last: last.assistantMessageEvent.delta, event: delta.delta }
      state.bytes[list] +=
        mergedDeltaBytes(state.sizes, merged, event, last, texts) - eventBytes(state.sizes, last)
      events[events.length - 1] = merged
      return events
    }
  }
  if (event.type === 'tool_execution_update') {
    events = events.filter(
      (e) => e.type !== 'tool_execution_update' || e.toolCallId !== event.toolCallId,
    )
    state.bytes[list] = listBytes(state.sizes, events)
  }
  events.push(event)
  state.bytes[list] += eventBytes(state.sizes, event)
  return events
}
