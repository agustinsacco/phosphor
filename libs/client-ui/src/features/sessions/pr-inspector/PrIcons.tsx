import type { GhPrCheckState, GhPrSummary, GhPullRequest } from '@shared/models'
import type { PrTone, PrVerdict } from '../prVerdict'

/**
 * Pull-request glyphs on a 16px grid, stroked in `currentColor`. The verdict
 * glyph carries the tone's meaning in shape as well as colour.
 */
type Glyph =
  | 'x'
  | 'check'
  | 'check2'
  | 'pending'
  | 'alert'
  | 'changes'
  | 'comment'
  | 'merged'
  | 'pr'
  | 'draft'
  | 'closed'
  | 'neutral'
  | 'skip'
  | 'plus'
  | 'external'
  | 'more'

const PATHS: Record<Glyph, React.ReactNode> = {
  x: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  check: <path d="M3.2 8.6l3 2.9L12.8 4.8" />,
  check2: <path d="M1.5 8.8l2.6 2.6L9.6 5M7.2 11.1l.3.3L14.5 5" />,
  pending: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 8V2.5A5.5 5.5 0 0 1 13.5 8Z" fill="currentColor" stroke="none" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.3L14.4 13.4H1.6Z" />
      <path d="M8 6.6v3M8 11.6v.1" />
    </>
  ),
  changes: <path d="M8 3v6M5 6h6M5 12.6h6" />,
  comment: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  merged: (
    <>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="8.5" r="1.6" />
      <path d="M4.5 5.1v5.8M4.5 5.6c0 2.2 2.4 2.9 5.4 2.9" />
    </>
  ),
  pr: (
    <>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="12.5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 10.9V6.6c0-1.2-.8-2-2-2H7.4M8.9 3.1L7.4 4.6l1.5 1.5" />
    </>
  ),
  draft: (
    <>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="12.5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 3v1M11.5 6.5v1.5" />
    </>
  ),
  closed: (
    <>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <path d="M4.5 5.1v5.8M10 3.5l3 3M13 3.5l-3 3M11.5 9v2" />
    </>
  ),
  neutral: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8h5" />
    </>
  ),
  skip: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.2 10.8l5.6-5.6" />
    </>
  ),
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  external: <path d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5L7 9" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r=".9" fill="currentColor" />
      <circle cx="8" cy="8" r=".9" fill="currentColor" />
      <circle cx="12.5" cy="8" r=".9" fill="currentColor" />
    </>
  ),
}

export function PrGlyph({
  glyph,
  size = 14,
  className,
}: {
  glyph: Glyph
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ? `shrink-0 ${className}` : 'shrink-0'}
    >
      {PATHS[glyph]}
    </svg>
  )
}

/** Text colour for a verdict tone. */
export const TONE_TEXT: Record<PrTone, string> = {
  failing: 'text-danger',
  conflict: 'text-danger',
  closed: 'text-danger',
  pending: 'text-warning',
  blocked: 'text-warning',
  review: 'text-success',
  ready: 'text-success',
  merged: 'text-merged',
  draft: 'text-text-tertiary',
  unknown: 'text-text-tertiary',
}

/** Soft fill and border for a chip or pill in a verdict tone. */
export const TONE_CHIP: Record<PrTone, string> = {
  failing: 'text-danger bg-danger-soft border-danger/30',
  conflict: 'text-danger bg-danger-soft border-danger/30',
  closed: 'text-danger bg-danger-soft border-danger/30',
  pending: 'text-warning bg-warning/10 border-warning/30',
  blocked: 'text-warning bg-warning/10 border-warning/30',
  review: 'text-success bg-success/10 border-success/30',
  ready: 'text-success bg-success/10 border-success/30',
  merged: 'text-merged bg-merged-soft border-merged/30',
  draft: 'text-text-secondary bg-chip border-border',
  unknown: 'text-text-secondary bg-chip border-border',
}

const TONE_GLYPH: Record<PrTone, Glyph> = {
  failing: 'x',
  conflict: 'alert',
  closed: 'closed',
  pending: 'pending',
  blocked: 'changes',
  review: 'check',
  ready: 'check2',
  merged: 'merged',
  draft: 'draft',
  unknown: 'neutral',
}

export function verdictGlyph(verdict: PrVerdict): Glyph {
  return verdict.word === 'Threads' ? 'comment' : TONE_GLYPH[verdict.tone]
}

export function stateGlyph(pr: GhPullRequest | GhPrSummary | undefined): Glyph {
  if (pr?.state === 'MERGED') return 'merged'
  if (pr?.state === 'CLOSED') return 'closed'
  if (pr?.state === 'DRAFT') return 'draft'
  return 'pr'
}

export const CHECK_GLYPH: Record<GhPrCheckState, [Glyph, string]> = {
  failure: ['x', 'text-danger'],
  pending: ['pending', 'text-warning'],
  success: ['check', 'text-success'],
  neutral: ['neutral', 'text-text-tertiary'],
  skipped: ['skip', 'text-text-tertiary'],
}
