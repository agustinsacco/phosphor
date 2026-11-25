import { utf8Length } from '@phosphor/shared/host-protocol'
import type { PiEvent } from '@phosphor/shared/rpc'
import type { PendingList, ProjectionState } from './projection-state'

/**
 * A projection's pending events (`tail`, or `barrier` while one holds) and their running
 * UTF-8 size as `JSON.stringify` encodes them. Each event is measured once, when it enters
 * pending, so the replay bound costs O(event) per event, not O(pending bytes).
 */
export interface PendingSizes {
  /** JSON bytes of each event. */
  event: WeakMap<PiEvent, number>
  /** Escaped text bytes (without quotes) and the last UTF-16 code unit of a merged delta. */
  text: WeakMap<PiEvent, DeltaTextSize>
}

export function createPendingSizes(): PendingSizes {
  return { event: new WeakMap(), text: new WeakMap() }
}

const jsonBytes = (value: unknown) => utf8Length(JSON.stringify(value))
type DeltaTextSize = { bytes: number; lastCodeUnit: number }

function measureDeltaText(text: string): DeltaTextSize {
  return { bytes: jsonBytes(text) - 2, lastCodeUnit: text.charCodeAt(text.length - 1) }
}

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
  // The wire guard is shallow; concatenation can coerce a value or add a missing field.
  if (typeof texts.last !== 'string' || typeof texts.event !== 'string')
    return eventBytes(sizes, merged)

  // Reading the end of the accumulated string can flatten it. Use the cached code unit.
  const earlier = sizes.text.get(last) ?? measureDeltaText(texts.last)
  const next = measureDeltaText(texts.event)
  const first = texts.event.charCodeAt(0)
  // Two lone surrogate escapes (6 bytes each) become one 4-byte character.
  const joinsPair =
    earlier.lastCodeUnit >= 0xd800 &&
    earlier.lastCodeUnit <= 0xdbff &&
    first >= 0xdc00 &&
    first <= 0xdfff
  const added = earlier.bytes - (joinsPair ? 8 : 0)
  sizes.text.set(merged, {
    bytes: next.bytes + added,
    lastCodeUnit: texts.event.length ? next.lastCodeUnit : earlier.lastCodeUnit,
  })
  const bytes = eventBytes(sizes, event) + added
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
