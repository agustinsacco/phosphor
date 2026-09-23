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
export const EXCERPT_MAX = 140

/**
 * The outcome of the run that just settled, or null when it should stay quiet.
 *
 * An aborted run is quiet: the only way to abort is the stop control, and that
 * means the user was already looking at the lane.
 */
export function laneOutcome(items: readonly ChatItem[]): LaneOutcome | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'user') return { kind: 'done' }
    if (item.kind !== 'assistant') continue
    if (item.stopReason === 'aborted') return null
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
export function excerptOf(markdown: string, max = EXCERPT_MAX): string | undefined {
  const withoutFences = markdown.replace(/```[\s\S]*?(```|$)/g, '\n')
  const line = withoutFences
    .split('\n')
    .map((raw) =>
      raw
        .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|\*|_|`|~~)(?=\S)([^*_`~]*?\S)\1/g, '$2')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((candidate) => candidate.length > 0 && !/^([-*_=|:\s])+$/.test(candidate))
  if (!line) return undefined
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`
}
