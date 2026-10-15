import { excerptOf } from '@shared/lane-excerpt'
import type { ChatItem } from '@/features/chat/chatItems'
import { parseExternalToolMarker } from '@/features/chat/items/transcriptRows'

/**
 * What a lane's finished run has to say for itself, as a notification.
 *
 * Pure, so the rules are testable without a store: which runs are worth a
 * notice at all, and which line of the reply stands in for it.
 */
export interface LaneOutcome {
  kind: 'done' | 'error'
  /** One line of the reply (or the error), or undefined when there is none. */
  excerpt?: string
}

/** Long enough to recognise the answer, short enough for two lines of card. */
export { EXCERPT_MAX } from '@shared/lane-excerpt'

/**
 * The outcome of the run that just settled. An aborted run gets no notice at
 * all; pi says so on `agent_settled`, so the caller never asks.
 */
export function laneOutcome(items: readonly ChatItem[]): LaneOutcome {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'user') return { kind: 'done' }
    if (item.kind !== 'assistant') continue
    if (item.stopReason === 'error' || item.errorMessage) {
      return { kind: 'error', excerpt: excerptOf(item.errorMessage ?? '') }
    }
    const text = item.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      // A Claude Code provider reports its own tool calls as marker text
      // blocks. They are transcript plumbing, not something the model said.
      .filter((text) => !parseExternalToolMarker(text))
      .join('\n')
    const excerpt = excerptOf(text)
    // A tool-only step has no prose; the reply is further back.
    if (excerpt) return { kind: 'done', excerpt }
  }
  return { kind: 'done' }
}

/**
 * The first meaningful line of some markdown, flattened to plain text.
 *
 * Deliberately crude — this is a preview, not a renderer. It drops code
 * fences, headings' hashes, list bullets and inline emphasis, keeps link text,
 * and clamps on a word boundary.
 */
export { excerptOf } from '@shared/lane-excerpt'
