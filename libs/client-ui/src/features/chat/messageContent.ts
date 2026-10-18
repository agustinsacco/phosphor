/**
 * Pure helpers that read pi message content and shape it for the view model.
 * No state, no events — safe to unit test in isolation.
 */
import type { AgentMessage, AssistantMessage, ImageContent } from '@shared/rpc'
import type { AssistantBlock, ChatItem, ToolState } from './chatItems'

export function isAssistant(message: AgentMessage): message is AssistantMessage {
  return 'role' in message && message.role === 'assistant'
}

export function lastAssistantIndex(items: ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind === 'assistant') return i
  }
  return -1
}

export function replaceItem(items: ChatItem[], index: number, item: ChatItem): ChatItem[] {
  const next = items.slice()
  next[index] = item
  return next
}

/** Extract plain text from a user message's content. */
export function userMessageText(message: {
  content: string | Array<{ type: string; text?: string }>
}): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
}

export function userMessageImages(message: {
  content: string | Array<{ type: string; data?: string; mimeType?: string }>
}): ImageContent[] | undefined {
  if (typeof message.content === 'string') return undefined
  const images = message.content
    .filter((b) => b.type === 'image' && typeof b.data === 'string')
    .map((b) => ({ type: 'image' as const, data: b.data!, mimeType: b.mimeType ?? 'image/png' }))
  return images.length > 0 ? images : undefined
}

/** Build assistant blocks from a final AssistantMessage content array. */
export function blocksFromContent(message: AssistantMessage): AssistantBlock[] {
  return message.content.map((block, index) => {
    if (block.type === 'text')
      return { type: 'text' as const, index, text: block.text, closed: true }
    if (block.type === 'thinking')
      return { type: 'thinking' as const, index, text: block.thinking, closed: true }
    return { type: 'tool' as const, index, toolCallId: block.id }
  })
}

/**
 * Tool state for one `toolCall` block, preserving anything already streamed.
 *
 * Exported so hydration can write states directly into a mutable record;
 * `toolsFromContent` copies the record, which is right for the immutable live
 * reducer but quadratic when replaying a whole transcript.
 */
export function toolStateForCall(
  block: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>,
  existing?: ToolState,
): ToolState {
  return {
    toolCallId: block.id,
    toolName: block.name,
    args: block.arguments,
    argsText: existing?.argsText ?? JSON.stringify(block.arguments ?? {}),
    status: existing?.status ?? 'starting',
    output: existing?.output ?? null,
    result: existing?.result,
    isError: existing?.isError,
    startedAt: existing?.startedAt,
    endedAt: existing?.endedAt,
  }
}

/** Merge tool states out of a final assistant message (ids/names/args). */
export function toolsFromContent(
  message: AssistantMessage,
  tools: Record<string, ToolState>,
): Record<string, ToolState> {
  let next = tools
  for (const block of message.content) {
    if (block.type !== 'toolCall') continue
    const existing = next[block.id]
    if (existing && existing.args) continue
    if (next === tools) next = { ...tools }
    next[block.id] = toolStateForCall(block, existing)
  }
  return next
}
