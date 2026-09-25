/**
 * Chat view-model reducer: folds the pi RPC event stream into renderable
 * items incrementally. Pure functions — unit-tested without React.
 *
 * Invariants:
 * - Never rebuilds unrelated items; each event touches at most one item plus
 *   the tools map.
 * - `tool_execution_update.partialResult` is accumulated output — REPLACE,
 *   never append.
 * - `message_end` content is authoritative; streamed deltas are best-effort.
 */
import type {
  AgentMessage,
  AssistantMessage,
  BashExecutionMessage,
  CustomMessage,
  PiEvent,
  ToolResultMessage,
} from '@shared/rpc'
import type {
  AssistantBlock,
  AssistantItem,
  BashItem,
  ChatItem,
  ChatSessionState,
  CustomItem,
  DividerItem,
  ToolState,
  UserItem,
} from './chatItems'
import { emptyChatSession, newItemId } from './chatItems'
import {
  applyRevealedIdentity,
  pendingToolId,
  pruneOrphanedPendingTools,
  revealedFromStart,
  withExecutionIdentity,
} from './toolIdentity'
import {
  blocksFromContent,
  isAssistant,
  lastAssistantIndex,
  replaceItem,
  toolsFromContent,
  userMessageImages,
  userMessageText,
  toolStateForCall,
} from './messageContent'

// The chat surface imports its types from here, so keep one public entry point.
export type {
  AssistantBlock,
  AssistantItem,
  BashItem,
  ChatItem,
  ChatSessionState,
  CustomItem,
  DividerItem,
  ToolState,
  ToolStatus,
  UserItem,
} from './chatItems'
export { emptyChatSession, newItemId } from './chatItems'
export { userMessageText } from './messageContent'

// ---------- the reducer ----------

/** Remove one delivered queue entry without disturbing duplicate messages. */
function removeFirst(items: string[], value: string): string[] {
  const index = items.indexOf(value)
  if (index === -1) return items
  return [...items.slice(0, index), ...items.slice(index + 1)]
}

export function reduceChatEvent(state: ChatSessionState, event: PiEvent): ChatSessionState {
  switch (event.type) {
    case 'agent_start':
      // agentStartedAt survives message_start/message_end rounds inside the
      // run: one continuous timer for the working indicator, not per-turn.
      return {
        ...state,
        isStreaming: true,
        error: null,
        agentStartedAt: Date.now(),
        // pi has spoken: the working indicator takes over from the booting one.
        promptSentAt: null,
      }

    case 'agent_end': {
      // A low-level run ended. pi may continue immediately with retry, a
      // queued steer/follow-up message, or compaction recovery; the
      // authoritative "fully done" signal is agent_settled. But an older pi
      // build (or protocol drift) is not guaranteed to emit that event, so
      // only stay visibly active here when this run reports a concrete
      // reason it will continue: `willRetry`, or an undelivered queue entry.
      // Otherwise finalize now, matching the pre-agent_settled behavior.
      const items = state.items.map((item) =>
        item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item,
      )
      const willContinue =
        event.willRetry === true ||
        state.queues.steering.length > 0 ||
        state.queues.followUp.length > 0
      if (willContinue) return { ...state, retry: null, items }
      return {
        ...state,
        isStreaming: false,
        retry: null,
        items,
        agentStartedAt: null,
        promptSentAt: null,
      }
    }

    case 'agent_settled':
      return {
        ...state,
        isStreaming: false,
        retry: null,
        agentStartedAt: null,
        promptSentAt: null,
        queues: { steering: [], followUp: [] },
      }

    case 'turn_start':
    case 'turn_end':
      return state

    case 'message_start': {
      const message = event.message
      if (isAssistant(message)) {
        const item: AssistantItem = {
          id: newItemId(),
          kind: 'assistant',
          blocks: [],
          streaming: true,
        }
        return { ...state, items: [...state.items, item] }
      }
      if ('role' in message && message.role === 'user') {
        // pi emits queue_update before this, but reconcile from the delivered
        // user message too. It makes the chip robust to a missed/coalesced
        // queue event and gives the click-like steer affordance a deterministic
        // end state as soon as the instruction is consumed.
        const text = userMessageText(message)
        const steering = removeFirst(state.queues.steering, text)
        const followUp =
          steering === state.queues.steering
            ? removeFirst(state.queues.followUp, text)
            : state.queues.followUp
        if (steering !== state.queues.steering || followUp !== state.queues.followUp) {
          return { ...state, queues: { steering, followUp } }
        }
      }
      return state
    }

    case 'message_update':
      return applyAssistantDelta(state, event)

    case 'message_end':
      return applyMessageEnd(state, event.message)

    case 'tool_execution_start':
      // The id may be unknown here: providers that withhold tool identity
      // during streaming leave a placeholder entry to adopt (see toolIdentity).
      return withExecutionIdentity(state, event.toolCallId, event.toolName, (existing) => ({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        argsText: existing?.argsText ?? JSON.stringify(event.args ?? {}),
        status: 'running',
        output: existing?.output ?? null,
        startedAt: Date.now(),
      }))

    case 'tool_execution_update':
      // Adopt first: a placeholder may still be holding this call's identity,
      // and dropping the event would strand the partial output.
      return withExecutionIdentity(state, event.toolCallId, event.toolName, (existing) => ({
        ...(existing ?? {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          argsText: '',
          output: null,
        }),
        // partialResult is accumulated: replace, don't append.
        output: event.partialResult,
        status: 'running' as const,
      }))

    case 'tool_execution_end':
      return withExecutionIdentity(state, event.toolCallId, event.toolName, (existing) => ({
        ...(existing ?? {
          toolCallId: event.toolCallId,
          argsText: '',
          output: null,
        }),
        toolName: event.toolName,
        result: event.result,
        output: event.result,
        isError: event.isError,
        status: event.isError ? 'error' : 'done',
        endedAt: Date.now(),
      }))

    case 'queue_update':
      return { ...state, queues: { steering: event.steering, followUp: event.followUp } }

    case 'compaction_start':
      return { ...state, isCompacting: true }

    case 'compaction_end': {
      const items = [...state.items]
      if (event.result) {
        items.push({
          id: newItemId(),
          kind: 'divider',
          variant: 'compaction',
          summary: event.result.summary,
          tokensBefore: event.result.tokensBefore,
          reason: event.reason,
        })
      } else if (!event.aborted && event.errorMessage) {
        items.push({
          id: newItemId(),
          kind: 'divider',
          variant: 'error',
          summary: `Compaction failed: ${event.errorMessage}`,
        })
      }
      return { ...state, isCompacting: false, items }
    }

    case 'auto_retry_start':
      return {
        ...state,
        retry: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        },
      }

    case 'auto_retry_end': {
      const items = event.success
        ? state.items
        : [
            ...state.items,
            {
              id: newItemId(),
              kind: 'divider' as const,
              variant: 'error' as const,
              summary: `Auto-retry gave up after ${event.attempt} attempts${event.finalError ? `: ${event.finalError}` : ''}`,
            },
          ]
      return { ...state, retry: null, items }
    }

    case 'extension_error': {
      const items = [
        ...state.items,
        {
          id: newItemId(),
          kind: 'divider' as const,
          variant: 'error' as const,
          summary: `Extension error${event.extensionPath ? ` (${event.extensionPath})` : ''}: ${event.error}`,
        },
      ]
      return { ...state, items }
    }

    default:
      return state
  }
}

/**
 * Append streamed text to the block at `contentIndex`, creating it when the
 * delta arrives before its `*_start` event. Blocks stay sorted by index so
 * out-of-order arrivals still render in the model's order.
 *
 * Shared by the `text` and `thinking` paths, which differ only in discriminant.
 */
function appendTextishDelta(
  blocks: AssistantBlock[],
  contentIndex: number,
  delta: string,
  kind: 'text' | 'thinking',
): AssistantBlock[] {
  if (blocks.some((b) => b.index === contentIndex)) {
    return blocks.map((b) =>
      b.index === contentIndex && b.type === kind ? { ...b, text: b.text + delta } : b,
    )
  }
  return [...blocks, { type: kind, index: contentIndex, text: delta, closed: false }].sort(
    (a, b) => a.index - b.index,
  )
}

function applyAssistantDelta(
  state: ChatSessionState,
  event: Extract<PiEvent, { type: 'message_update' }>,
): ChatSessionState {
  const delta = event.assistantMessageEvent
  const index = lastAssistantIndex(state.items)
  if (index === -1) return state
  const item = state.items[index] as AssistantItem

  const ensureBlock = (
    blocks: AssistantBlock[],
    contentIndex: number,
    make: () => AssistantBlock,
  ): AssistantBlock[] => {
    if (blocks.some((b) => b.index === contentIndex)) return blocks
    return [...blocks, make()].sort((a, b) => a.index - b.index)
  }

  switch (delta.type) {
    case 'start':
      return state

    case 'text_start':
    case 'thinking_start': {
      const kind = delta.type === 'text_start' ? 'text' : 'thinking'
      const blocks = ensureBlock(item.blocks, delta.contentIndex, () => ({
        type: kind,
        index: delta.contentIndex,
        text: '',
        closed: false,
      }))
      return { ...state, items: replaceItem(state.items, index, { ...item, blocks }) }
    }

    case 'text_delta':
    case 'thinking_delta': {
      const kind = delta.type === 'text_delta' ? 'text' : 'thinking'
      const blocks = appendTextishDelta(item.blocks, delta.contentIndex, delta.delta, kind)
      return { ...state, items: replaceItem(state.items, index, { ...item, blocks }) }
    }

    case 'text_end':
    case 'thinking_end': {
      const kind = delta.type === 'text_end' ? 'text' : 'thinking'
      const blocks = item.blocks.map((b) =>
        b.index === delta.contentIndex && b.type === kind
          ? { ...b, text: delta.content ?? b.text, closed: true }
          : b,
      )
      return { ...state, items: replaceItem(state.items, index, { ...item, blocks }) }
    }

    case 'toolcall_start': {
      // pi 0.84.3+ names the call on this event; when it doesn't, key the tool
      // under a placeholder and leave the name unknown rather than inventing
      // one (see toolIdentity).
      const revealed = revealedFromStart(delta)
      const toolCallId = revealed?.id ?? pendingToolId(item.id, delta.contentIndex)

      const blocks = ensureBlock(item.blocks, delta.contentIndex, () => ({
        type: 'tool',
        index: delta.contentIndex,
        toolCallId,
      }))
      const tools = state.tools[toolCallId]
        ? state.tools
        : {
            ...state.tools,
            [toolCallId]: {
              toolCallId,
              toolName: revealed?.name ?? null,
              argsText: '',
              status: 'starting' as const,
              output: null,
            },
          }
      return { ...state, items: replaceItem(state.items, index, { ...item, blocks }), tools }
    }

    case 'toolcall_delta': {
      // No identity can arrive on a delta: pi names the call on `toolcall_start`
      // (0.84.3+) or not until `toolcall_end`. Reading a mid-stream `partial`
      // here was dead code once pi 0.84.0 stopped sending that snapshot.
      const current = state.items[index] as AssistantItem
      const block = current.blocks.find((b) => b.index === delta.contentIndex)
      if (!block || block.type !== 'tool') return state
      const tool = state.tools[block.toolCallId]
      if (!tool) return state
      return {
        ...state,
        tools: {
          ...state.tools,
          [block.toolCallId]: { ...tool, argsText: tool.argsText + delta.delta },
        },
      }
    }

    case 'toolcall_end': {
      const block = item.blocks.find((b) => b.index === delta.contentIndex)
      if (!block || block.type !== 'tool' || !delta.toolCall) return state
      const finalId = delta.toolCall.id

      // Re-key through the single owner of identity moves (toolIdentity.ts),
      // then overlay what only this event is authoritative for: final args.
      const rekeyed = applyRevealedIdentity(state, index, delta.contentIndex, {
        id: finalId,
        name: delta.toolCall.name,
      })
      const tool = rekeyed.tools[finalId] ?? {
        toolCallId: finalId,
        toolName: delta.toolCall.name,
        argsText: '',
        status: 'starting' as const,
        output: null,
      }
      return {
        ...rekeyed,
        tools: {
          ...rekeyed.tools,
          [finalId]: {
            ...tool,
            args: delta.toolCall.arguments,
            argsText: tool.argsText || JSON.stringify(delta.toolCall.arguments ?? {}),
            status: tool.status === 'running' || tool.status === 'done' ? tool.status : 'starting',
          },
        },
      }
    }

    case 'done': {
      const updated: AssistantItem = { ...item, stopReason: delta.reason }
      return { ...state, items: replaceItem(state.items, index, updated) }
    }

    case 'error': {
      const message = delta.message
      const updated: AssistantItem = {
        ...item,
        streaming: false,
        stopReason: delta.reason,
        errorMessage:
          message?.errorMessage ?? (typeof delta.error === 'string' ? delta.error : undefined),
      }
      return { ...state, items: replaceItem(state.items, index, updated) }
    }

    default:
      return state
  }
}

/**
 * Fold a persisted `toolResult` into the tools record.
 *
 * Shared by the live reducer and by hydration so resume and streaming cannot
 * drift. `result` and `output` intentionally reference the SAME object rather
 * than two structurally-equal copies: they mean different things (final vs
 * latest-partial) so both fields stay, but a tool payload is often large — one
 * real session held 293KB of payloads, which the previous two-object form
 * retained as 585KB.
 */
function toolStateForResult(existing: ToolState | undefined, result: ToolResultMessage): ToolState {
  const base: ToolState = existing ?? {
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    argsText: '',
    status: 'running',
    output: null,
  }
  const payload = { content: result.content, details: result.details }
  return {
    ...base,
    result: payload,
    output: payload,
    isError: result.isError,
    status: result.isError ? 'error' : 'done',
    endedAt: base.endedAt ?? Date.now(),
  }
}

function applyToolResult(
  tools: Record<string, ToolState>,
  result: ToolResultMessage,
): Record<string, ToolState> {
  return {
    ...tools,
    [result.toolCallId]: toolStateForResult(tools[result.toolCallId], result),
  }
}

function applyMessageEnd(state: ChatSessionState, message: AgentMessage): ChatSessionState {
  if (!('role' in message)) return state

  switch (message.role) {
    case 'assistant': {
      const assistant = message as AssistantMessage
      const index = lastAssistantIndex(state.items)
      if (index === -1) {
        // No streamed counterpart (e.g. hydration edge): append final.
        const item: AssistantItem = {
          id: newItemId(),
          kind: 'assistant',
          blocks: blocksFromContent(assistant),
          streaming: false,
          stopReason: assistant.stopReason,
          errorMessage: assistant.errorMessage,
          usage: assistant.usage,
          model: assistant.model,
          timestamp: assistant.timestamp,
        }
        const items = [...state.items, item]
        return {
          ...state,
          items,
          tools: pruneOrphanedPendingTools(toolsFromContent(assistant, state.tools), items),
        }
      }
      const item = state.items[index] as AssistantItem
      const updated: AssistantItem = {
        ...item,
        blocks: blocksFromContent(assistant),
        streaming: false,
        stopReason: assistant.stopReason,
        errorMessage: assistant.errorMessage,
        usage: assistant.usage,
        model: assistant.model,
        timestamp: assistant.timestamp,
      }
      const items = replaceItem(state.items, index, updated)
      return {
        ...state,
        items,
        // The authoritative content re-keys blocks to real ids; drop any
        // pending-* entries that no longer back a rendered block (the
        // ordering real pi produces — message_end before tool_execution_*).
        tools: pruneOrphanedPendingTools(toolsFromContent(assistant, state.tools), items),
      }
    }

    case 'user': {
      const text = userMessageText(message)
      // Dedup against the optimistic item we appended on send.
      for (let i = state.items.length - 1; i >= 0; i--) {
        const item = state.items[i]!
        if (item.kind === 'assistant') continue
        if (item.kind === 'user') {
          if (item.optimistic && item.text === text) {
            // Take pi's timestamp: it is what rewind matches the row to its
            // entry by (`matchRenderedUserMessage`), and the optimistic item
            // never had one.
            const items = replaceItem(state.items, i, {
              ...item,
              optimistic: false,
              timestamp: message.timestamp,
            })
            return { ...state, items }
          }
          break
        }
        break
      }
      const item: UserItem = {
        id: newItemId(),
        kind: 'user',
        text,
        images: userMessageImages(message),
        timestamp: message.timestamp,
      }
      return { ...state, items: [...state.items, item] }
    }

    case 'toolResult':
      return { ...state, tools: applyToolResult(state.tools, message as ToolResultMessage) }

    case 'custom':
    case 'customMessage': {
      const item = customItemFrom(message as CustomMessage)
      // `display: false` means the extension wants it hidden from the UI.
      return item ? { ...state, items: [...state.items, item] } : state
    }

    default:
      return state
  }
}

/**
 * Build a renderable item from an extension-injected message.
 * Returns null when the extension marked it non-displayable.
 */
function customItemFrom(message: CustomMessage): CustomItem | null {
  if (message.display === false) return null
  const content = message.content
  const text =
    typeof content === 'string'
      ? content
      : (userMessageText({ content: content as Array<{ type: string; text?: string }> }) ?? '')
  const images = userMessageImages({
    content: content as string | Array<{ type: string; data?: string; mimeType?: string }>,
  })
  if (!text && !images) return null
  return {
    id: newItemId(),
    kind: 'custom',
    customType: typeof message.customType === 'string' ? message.customType : undefined,
    text,
    images,
    // `customMessage` role == pi's custom_message entry: it reaches the LLM.
    inContext: message.role === 'customMessage',
  }
}

// ---------- hydration from get_messages (resume / attach) ----------

export function hydrateFromMessages(messages: AgentMessage[]): ChatSessionState {
  /*
   * Accumulate into a MUTABLE array, then build the state object once.
   *
   * This used to do `state = { ...state, items: [...state.items, item] }` per
   * message, copying the whole array every iteration — O(n^2) in transcript
   * length, on the critical path of opening a session. `toolResult` additionally
   * routed through applyMessageEnd, which spread the entire `tools` record per
   * result, for a second O(n^2).
   */
  const items: ChatItem[] = []
  const tools: Record<string, ToolState> = {}
  for (const message of messages) {
    if (!('role' in message)) continue
    switch (message.role) {
      case 'user': {
        const item: UserItem = {
          id: newItemId(),
          kind: 'user',
          text: userMessageText(message),
          images: userMessageImages(message),
          timestamp: message.timestamp,
        }
        items.push(item)
        break
      }
      case 'assistant': {
        const assistant = message as AssistantMessage
        const item: AssistantItem = {
          id: newItemId(),
          kind: 'assistant',
          blocks: blocksFromContent(assistant),
          streaming: false,
          stopReason: assistant.stopReason,
          errorMessage: assistant.errorMessage,
          usage: assistant.usage,
          model: assistant.model,
          timestamp: assistant.timestamp,
        }
        items.push(item)
        // Write this message's tool calls straight into the mutable record.
        // Deliberately NOT `toolsFromContent` (returns a fresh record) nor
        // `Object.assign` of its result (copies every accumulated key back) —
        // both are quadratic across a long transcript.
        for (const block of assistant.content) {
          if (block.type !== 'toolCall') continue
          if (tools[block.id]?.args) continue
          tools[block.id] = toolStateForCall(block, tools[block.id])
        }
        break
      }
      case 'toolResult': {
        // Assign in place: `applyToolResult` copies the whole record, which is
        // correct for the live reducer (immutable state) but quadratic here.
        const result = message as ToolResultMessage
        tools[result.toolCallId] = toolStateForResult(tools[result.toolCallId], result)
        break
      }
      case 'bashExecution': {
        const bash = message as BashExecutionMessage
        const item: BashItem = {
          id: newItemId(),
          kind: 'bash',
          command: bash.command,
          output: bash.output,
          exitCode: bash.exitCode,
          running: false,
          truncated: bash.truncated,
          fullOutputPath: bash.fullOutputPath,
          excludeFromContext: bash.excludeFromContext,
        }
        items.push(item)
        break
      }
      case 'compactionSummary': {
        const item: DividerItem = {
          id: newItemId(),
          kind: 'divider',
          variant: 'compaction',
          summary: (message as { summary?: string }).summary,
          tokensBefore: (message as { tokensBefore?: number }).tokensBefore,
        }
        items.push(item)
        break
      }
      case 'branchSummary': {
        const item: DividerItem = {
          id: newItemId(),
          kind: 'divider',
          variant: 'branchSummary',
          summary: (message as { summary?: string }).summary,
        }
        items.push(item)
        break
      }
      case 'custom':
      case 'customMessage': {
        const item = customItemFrom(message as CustomMessage)
        if (item) items.push(item)
        break
      }
      default:
        break
    }
  }
  return { ...emptyChatSession(), items, tools }
}
