import { prUrl } from '@shared/github-pr-refs'
import type { LanePr } from './lanePrs'
import type { PrTone } from './prVerdict'

/** Beads a row shows before the rest collapse into `+N`. */
export const PR_BEAD_LIMIT = 3

/** `Failing`, or what we can say when the status was never read. */
function prWord(lane: LanePr): string {
  return !lane.pr && lane.stale ? 'Status unavailable' : lane.verdict.word
}

/** One PR on one line: `#57 Failing · Rocky review failed (not required)`. */
export function prBeadLine(lane: LanePr): string {
  const word = prWord(lane)
  const { headline } = lane.verdict
  const why = lane.pr && headline !== word ? ` · ${headline}` : ''
  const old = lane.stale && lane.pr ? ' (may be out of date)' : ''
  return `#${lane.number} ${word}${why}${old}`
}

/** The row menu's entry for one PR: `#57 · Failing`. */
export function prMenuLabel(lane: LanePr): string {
  return `#${lane.number} · ${prWord(lane)}`
}

/** Where a PR opens: what GitHub said, else built from its ref. */
export function lanePrUrl(lane: LanePr): string | undefined {
  return lane.pr?.url ?? (lane.ref ? prUrl(lane.ref) : undefined)
}

export interface PrBeadsView {
  /** The beads to draw, lead first. */
  shown: LanePr[]
  /** How many PRs the `+N` stands for. */
  more: number
  /** Every PR, one line each, for the tooltip and the label. */
  lines: string[]
  /** The lead's tone: the group's `data-variant`. */
  tone: PrTone
}

/** A lane's own PRs as beads. Callers pass them in `compareLanePrs` order, lead first. */
export function prBeads(prs: LanePr[]): PrBeadsView {
  return {
    shown: prs.slice(0, PR_BEAD_LIMIT),
    more: Math.max(0, prs.length - PR_BEAD_LIMIT),
    lines: prs.map(prBeadLine),
    tone: prs[0]?.verdict.tone ?? 'unknown',
  }
}
