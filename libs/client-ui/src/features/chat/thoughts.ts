/**
 * What a thought row says about itself: a one-line headline and how long the
 * model thought.
 *
 * Both reference apps show thinking this way. While the model thinks, a live
 * line carries the latest headline and an elapsed timer; once it stops, the
 * thought folds into "Thought for 12s" and opens to the full text on click.
 *
 * The headline comes from the text itself, because the providers already
 * write one:
 *
 * - Codex reasoning summaries open each section with a bold title
 *   (`**Evaluating standard-library parsing**`). 1,399 of 1,467 recent Codex
 *   thoughts in pi sessions did.
 * - Claude summaries are prose. Their headline is the first sentence of a
 *   paragraph.
 *
 * `latest` picks the newest section, which is what a live line should show;
 * `first` picks the opening one, which is what a settled row should show.
 */

/** Longest headline kept. The row truncates visually well before this. */
const MAX_HEADLINE = 160

/** A Codex section title: a bold run that is the whole first line. */
const TITLE = /^\*\*(.+?)\*\*\s*$/

/** Inline markdown reduced to its text, so a headline never shows syntax. */
function plain(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The first sentence of a paragraph, or the paragraph when it has none. */
function firstSentence(paragraph: string): string {
  const text = plain(paragraph)
  // A period followed by whitespace ends a sentence; one inside a version
  // number or a file name does not, because no space follows it directly.
  const end = text.search(/[.!?](\s|$)/)
  return end === -1 ? text : text.slice(0, end + 1)
}

function clip(text: string): string {
  return text.length > MAX_HEADLINE ? `${text.slice(0, MAX_HEADLINE - 1).trimEnd()}…` : text
}

/**
 * One-line headline for a thought, or `undefined` when it has no text (a
 * provider that returned only a signature).
 */
export function thoughtHeadline(text: string, which: 'first' | 'latest'): string | undefined {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (paragraphs.length === 0) return undefined

  const titles = paragraphs
    .map((p) => TITLE.exec(p.split('\n')[0]!.trim())?.[1])
    .filter((t): t is string => !!t && plain(t).length > 0)
  if (titles.length > 0) {
    return clip(plain(which === 'latest' ? titles[titles.length - 1]! : titles[0]!))
  }

  const paragraph = which === 'latest' ? paragraphs[paragraphs.length - 1]! : paragraphs[0]!
  const sentence = firstSentence(paragraph)
  return sentence ? clip(sentence) : undefined
}

/**
 * The newest sentence of a thought: what the model is on right now, shown
 * by a live thought's row. A section title is the headline, so a section that
 * has only its title so far has no tail yet (the row falls back to it).
 */
export function thoughtTail(text: string): string | undefined {
  const last = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .at(-1)
  if (!last || TITLE.test(last)) return undefined
  const sentences = plain(last)
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
  const tail = sentences.at(-1)
  return tail ? clip(tail) : undefined
}

/** The timing a thinking block carries when it streamed in this window. */
export interface ThoughtTiming {
  startedAt?: number
  endedAt?: number
}

/**
 * Total time spent thinking across `blocks`, or `undefined` when any of them
 * has no timing (loaded from history, where pi records none). Partial sums
 * would claim a shorter thought than the model took.
 */
export function thoughtDuration(blocks: ThoughtTiming[], now: number): number | undefined {
  if (blocks.length === 0) return undefined
  let total = 0
  for (const block of blocks) {
    if (block.startedAt === undefined) return undefined
    total += Math.max(0, (block.endedAt ?? now) - block.startedAt)
  }
  return total
}

/** "Thought for 12s", or "Thought" when the duration is unknown. */
export function thoughtLabel(durationMs: number | undefined): string {
  if (durationMs === undefined) return 'Thought'
  return `Thought for ${formatSeconds(durationMs)}`
}

/** Whole seconds, then minutes: a thinking timer never shows milliseconds. */
export function formatSeconds(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}
