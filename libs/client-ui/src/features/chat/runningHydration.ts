/**
 * History for a lane opened while its turn runs. pi's `get_messages` holds only finished
 * messages, and main forwards each event as pi prints it but answers the request later, so an
 * event that arrived while the history loaded may be in those messages or not yet. The
 * transcript is the messages, then every event since the renderer attached to the lane, minus
 * what the messages already hold: a message whose end they include, and the progress of a tool
 * call whose result they include. It starts from pi's activity as the lane opened.
 */
import type { AgentMessage, PiEvent, RpcSessionState } from '@shared/rpc'
import type { ChatSessionState } from './chatItems'
import { hydrateFromMessages, reduceChatEvent } from './reducer'

type ToolEvent = Extract<
  PiEvent,
  { type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end' }
>
const isMessageEvent = (event: PiEvent): boolean =>
  event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end'
const isToolEvent = (event: PiEvent): event is ToolEvent =>
  event.type === 'tool_execution_start' ||
  event.type === 'tool_execution_update' ||
  event.type === 'tool_execution_end'

/** One message's events: from its start (or the first event seen, for one already under way). */
interface MessageEvents {
  end?: AgentMessage
}

/** pi's activity as the lane opened: the chat's own, and pi's last reported state. */
export interface OpenedActivity {
  isStreaming: boolean
  isCompacting: boolean
  meta?: Pick<RpcSessionState, 'isStreaming' | 'isCompacting'> | null
}
const IDLE: OpenedActivity = { isStreaming: false, isCompacting: false }

/** Groups each message event with the message it belongs to; -1 for other events. */
function messageGroups(events: readonly PiEvent[]): { groups: MessageEvents[]; of: number[] } {
  const groups: MessageEvents[] = []
  let open = false
  const of = events.map((event) => {
    if (!isMessageEvent(event)) return -1
    if (event.type === 'message_start' || !open) {
      groups.push({})
      open = true
    }
    if (event.type === 'message_end') {
      groups.at(-1)!.end = event.message
      open = false
    }
    return groups.length - 1
  })
  return { groups, of }
}

/** Messages the history already holds, among its last `count`: only those can have ended since. */
function heldMessages(messages: readonly AgentMessage[], count: number): Set<string> {
  return new Set(messages.slice(-count).map((message) => JSON.stringify(message)))
}

export function hydrateRunning(
  messages: AgentMessage[],
  events: readonly PiEvent[],
  activity: OpenedActivity = IDLE,
): ChatSessionState {
  const { groups, of } = messageGroups(events)
  const held = heldMessages(messages, groups.filter((group) => group.end).length)
  const isHeld = (group: MessageEvents): boolean =>
    !!group.end && held.has(JSON.stringify(group.end))
  const results = new Set(
    messages.flatMap((message) => (message.role === 'toolResult' ? [message.toolCallId] : [])),
  )
  const summaries = new Set(
    messages.flatMap((message) => (message.role === 'compactionSummary' ? [message.summary] : [])),
  )
  // A turn already running starts as if this window saw it begin, so the composer offers Stop.
  // Before the events, so a turn that ended while the history loaded comes up idle. An answer
  // already streaming gets its own item from the reducer.
  let state = hydrateFromMessages(messages)
  if (activity.isStreaming || activity.meta?.isStreaming)
    state = reduceChatEvent(state, { type: 'agent_start' })
  if (activity.isCompacting || activity.meta?.isCompacting) state = { ...state, isCompacting: true }
  events.forEach((event, index) => {
    const group = groups[of[index]!]
    if (group) {
      if (isHeld(group)) return
    } else if (isToolEvent(event) && results.has(event.toolCallId)) {
      return
    } else if (
      event.type === 'compaction_end' &&
      event.result &&
      summaries.has(event.result.summary)
    ) {
      // The history already shows this compaction's divider.
      state = { ...state, isCompacting: false }
      return
    }
    state = reduceChatEvent(state, event)
  })
  return state
}
