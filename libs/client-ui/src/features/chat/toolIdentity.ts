/**
 * Tool identity while a `toolcall` block is still streaming.
 *
 * Providers disagree about *when* a tool call's real id and name become known:
 *
 * - pi 0.84.3+ puts both on the `toolcall_start` event itself, so the card is
 *   titled before the argument payload finishes streaming.
 * - Older pi, and providers that withhold identity while streaming (Bedrock-
 *   routed Claude), send neither until `toolcall_end` — i.e. after the entire
 *   argument payload has streamed, which for a large `write` or
 *   `artifact_create` is minutes of wall clock.
 *
 * There used to be a third case read off `assistantMessageEvent.partial`.
 * pi 0.84.0 stopped sending that snapshot, so the mid-stream reveal was dead
 * code quietly leaving every card on its placeholder; `toolcall_start` is now
 * the only up-front source, and the field is checked for presence rather than
 * assumed.
 *
 * Until the real id arrives the tool has to be keyed under *something*, so we
 * mint a deterministic placeholder from the item id + content index and leave
 * `toolName` null (rather than the string `'unknown'`, which leaked into the UI
 * as "Running unknown" / "unknown arguments").
 *
 * The important part is that every later event which learns the real identity —
 * `toolcall_end`, or a `tool_execution_*` event arriving first — **adopts**
 * that placeholder instead of inserting a
 * second tool entry. Before this, the placeholder stayed on screen forever at
 * `status: 'starting'` while the real entry (holding the actual output)
 * accumulated under a key nothing rendered.
 */
import type { AssistantMessageEvent } from '@shared/rpc'
import type { AssistantItem, ChatSessionState, ToolState } from './chatItems'
import { replaceItem } from './messageContent'

export const pendingToolId = (itemId: string, contentIndex: number): string =>
  `pending-${itemId}-${contentIndex}`

export const isPendingToolId = (toolCallId: string): boolean => toolCallId.startsWith('pending-')

export interface RevealedTool {
  id: string
  name: string
}

/**
 * The real id/name on a `toolcall_start`, or null if this pi build (or
 * provider) withholds identity until `toolcall_end`.
 *
 * Needs *both* fields before revealing: re-keying onto a real id with no name
 * would render a title-less card, which is worse than the honest placeholder.
 */
export function revealedFromStart(
  delta: Extract<AssistantMessageEvent, { type: 'toolcall_start' }>,
): RevealedTool | null {
  if (!delta.id || !delta.toolName) return null
  return { id: delta.id, name: delta.toolName }
}

/**
 * Re-key a streaming tool block onto its real id/name, preserving everything
 * accumulated under the placeholder (streamed args text, status, output).
 * No-op when the block already carries that identity.
 */
export function applyRevealedIdentity(
  state: ChatSessionState,
  itemIndex: number,
  contentIndex: number,
  revealed: RevealedTool,
): ChatSessionState {
  const item = state.items[itemIndex]
  if (!item || item.kind !== 'assistant') return state
  const block = item.blocks.find((b) => b.index === contentIndex)
  if (!block || block.type !== 'tool') return state

  const oldId = block.toolCallId
  const previous = state.tools[oldId]
  if (oldId === revealed.id && previous?.toolName === revealed.name) return state

  const tools = { ...state.tools }
  if (oldId !== revealed.id) delete tools[oldId]
  tools[revealed.id] = {
    ...(previous ?? { argsText: '', status: 'starting' as const, output: null }),
    toolCallId: revealed.id,
    toolName: revealed.name,
  }

  const blocks =
    oldId === revealed.id
      ? item.blocks
      : item.blocks.map((b) =>
          b.index === contentIndex && b.type === 'tool' ? { ...b, toolCallId: revealed.id } : b,
        )

  return { ...state, items: replaceItem(state.items, itemIndex, { ...item, blocks }), tools }
}

/**
 * A `tool_execution_*` event arrived for an id we've never seen, because the
 * stream never revealed it. Hand that identity to the lowest-content-index
 * still-unidentified tool block within the MOST RECENT assistant item (items
 * are scanned newest-first, so a stale placeholder from a dead earlier turn
 * can never steal a new execution).
 *
 * Ordering: pi emits `tool_execution_start` in call order and blocks are sorted
 * by content index, so first-unadopted-wins matches the provider's own pairing
 * for parallel tool calls.
 */
export function adoptPendingTool(
  state: ChatSessionState,
  revealed: RevealedTool,
): ChatSessionState | null {
  for (let itemIndex = state.items.length - 1; itemIndex >= 0; itemIndex--) {
    const item = state.items[itemIndex]
    if (!item || item.kind !== 'assistant') continue
    const candidate = pendingBlocks(item).find((block) => {
      // Pending entries always carry toolName null (a revealed name re-keys
      // the entry off its pending id), so name matching is unnecessary here.
      const tool = state.tools[block.toolCallId]
      return tool != null && tool.toolName == null
    })
    if (!candidate) continue
    return applyRevealedIdentity(state, itemIndex, candidate.index, revealed)
  }
  return null
}

function pendingBlocks(item: AssistantItem): { index: number; toolCallId: string }[] {
  return item.blocks
    .flatMap((b) => (b.type === 'tool' ? [{ index: b.index, toolCallId: b.toolCallId }] : []))
    .filter((b) => isPendingToolId(b.toolCallId))
    .sort((a, b) => a.index - b.index)
}

/**
 * Drop placeholder tools-map entries no block references anymore.
 *
 * Real pi emits the authoritative `message_end` BEFORE any `tool_execution_*`
 * event (pi-agent-core's loop awaits the stream, then executes tools). When a
 * provider never revealed identity during streaming, `message_end` re-keys
 * the rendered blocks to real ids via content — leaving the accumulated
 * `pending-*` entry orphaned in `state.tools` forever unless pruned here.
 */
export function pruneOrphanedPendingTools(
  tools: Record<string, ToolState>,
  items: ChatSessionState['items'],
): Record<string, ToolState> {
  const referenced = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      if (block.type === 'tool') referenced.add(block.toolCallId)
    }
  }
  let next = tools
  for (const key of Object.keys(tools)) {
    if (!isPendingToolId(key) || referenced.has(key)) continue
    if (next === tools) next = { ...tools }
    delete next[key]
  }
  return next
}

/**
 * Merge a `tool_execution_*` event into the tools map, adopting a placeholder
 * entry first when the id is unknown.
 */
export function withExecutionIdentity(
  state: ChatSessionState,
  toolCallId: string,
  toolName: string,
  patch: (existing: ToolState | undefined) => ToolState,
): ChatSessionState {
  const base = state.tools[toolCallId]
    ? state
    : (adoptPendingTool(state, { id: toolCallId, name: toolName }) ?? state)
  return {
    ...base,
    tools: { ...base.tools, [toolCallId]: patch(base.tools[toolCallId]) },
  }
}
