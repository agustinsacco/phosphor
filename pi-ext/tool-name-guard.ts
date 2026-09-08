/**
 * Phosphor extension: keep malformed tool calls out of the session file.
 *
 * A model can emit a tool call whose *name* is not a tool name at all. Seen in
 * production from MiniMax M2 on Bedrock, which leaked its raw tool-call syntax
 * into the name field:
 *
 *   toolCall.name === 'mcp({})<tool_call>find'
 *
 * pi handles that gracefully in the moment — the call just fails with "Tool
 * ... not found" — and then writes it to the session file. That is where the
 * damage is done. Every later turn replays the transcript, and Bedrock
 * validates tool names against `[a-zA-Z0-9_-]+` on the way in, so the whole
 * session is rejected from then on:
 *
 *   Validation error: Value at 'messages.3.member.content.2.member.toolUse.name'
 *   failed to satisfy constraint: Member must satisfy regular expression
 *   pattern: [a-zA-Z0-9_-]+
 *
 * One bad name permanently bricks a thread, with no way back from the UI. So
 * this rewrites the finalized assistant message before pi persists it: the
 * malformed call becomes plain text, which keeps the model's intent visible in
 * the transcript while removing the poison.
 *
 * Deliberately conservative. It only touches names that no provider would
 * accept, and never rewrites arguments or well-formed calls.
 */

/** The strictest name shape any supported provider will accept. */
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]+$/

/**
 * Anthropic caps tool names at 128 chars; a longer one is malformed by any
 * standard and is usually a sign of the same syntax-leak failure.
 */
const MAX_TOOL_NAME_LENGTH = 128

export function isMalformedToolName(name: unknown): boolean {
  if (typeof name !== 'string') return true
  if (name.length === 0 || name.length > MAX_TOOL_NAME_LENGTH) return true
  return !VALID_TOOL_NAME.test(name)
}

/** Human-readable stand-in for a call we refused to persist. */
export function describeDroppedCall(name: unknown, args: unknown): string {
  const shown = typeof name === 'string' ? name : String(name)
  let argsText = ''
  try {
    const json = JSON.stringify(args ?? {})
    if (json && json !== '{}') argsText = ` ${json.slice(0, 200)}`
  } catch {
    /* unserializable args: the name alone is enough to explain the drop */
  }
  return `[Phosphor dropped a malformed tool call: ${shown}${argsText}]`
}

interface ContentBlock {
  type: string
  name?: unknown
  arguments?: unknown
  text?: string
}

/**
 * Returns a sanitized copy when the message contained a malformed call, or
 * null when there was nothing to fix (so the caller can leave it untouched).
 */
export function sanitizeMessage(message: {
  role?: string
  content?: unknown
}): { content: ContentBlock[] } | null {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return null
  const blocks = message.content as ContentBlock[]
  if (!blocks.some((b) => b?.type === 'toolCall' && isMalformedToolName(b.name))) {
    return null
  }
  return {
    content: blocks.map((block) =>
      block?.type === 'toolCall' && isMalformedToolName(block.name)
        ? { type: 'text', text: describeDroppedCall(block.name, block.arguments) }
        : block,
    ),
  }
}

interface PiExtensionApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
}

export default function toolNameGuardExtension(pi: PiExtensionApi): void {
  pi.on('message_end', (event: unknown) => {
    const message = (event as { message?: { role?: string; content?: unknown } })?.message
    if (!message) return undefined
    const sanitized = sanitizeMessage(message)
    if (!sanitized) return undefined
    console.error('[Phosphor] dropped a malformed tool call before it reached the session file')
    // The replacement must keep the original role (pi's contract).
    return { message: { ...message, content: sanitized.content } }
  })
}
