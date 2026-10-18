import type { PiEvent } from '@shared/rpc'

/**
 * Drop the event payloads that cross IPC only to be thrown away.
 *
 * Two pi events restate a whole run's content after it has already been
 * streamed block by block:
 *
 * - `agent_end.messages` — every message of the run.
 * - `turn_end.toolResults` — every tool result of the turn.
 *
 * The renderer reads neither. `reduceChatEvent` uses `agent_end.willRetry` and
 * nothing else from that event, and its `turn_end` branch is
 * `return state`. Everything those arrays contain has already arrived through
 * `message_start` / `message_update` / `message_end` and the tool events, so
 * forwarding them means structured-cloning a second copy of the turn across
 * the process boundary for no reader at all.
 *
 * **The arrays are emptied, not removed, and no event is dropped.** Both
 * fields are required by `shared/rpc.ts`, which is a hand-mirror of pi's
 * protocol carrying deliberate compile-time drift guards — narrowing it here
 * to make a field optional would weaken the guard for everyone. Emptying at
 * the boundary keeps the wire shape intact, keeps the change reversible, and
 * keeps the drift guards doing their job.
 *
 * This trims only what goes to the RENDERER. Anything subscribing to the
 * client directly still sees every event whole.
 */
export function trimForRenderer(event: PiEvent): PiEvent {
  if (event.type === 'agent_end' && event.messages.length > 0) {
    return { ...event, messages: [] }
  }
  if (event.type === 'turn_end' && event.toolResults.length > 0) {
    return { ...event, toolResults: [] }
  }
  return event
}
