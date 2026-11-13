import type { PrTone } from './prVerdict'

/**
 * One small stroked glyph per PR verdict tone, on a 16-unit grid so it stays
 * crisp at 10px inside a bead. The shape carries the verdict on its own, so
 * colour is never the only signal: ✕ failing, ! conflict, a slash for closed,
 * a half-filled clock for running, ↺ for changes requested, ✓ in review, ✓✓
 * ready, the merge glyph, and an ellipsis while the status is still unread.
 * A draft has no glyph: its bead's dashed outline is the shape.
 */
const PATHS: Record<Exclude<PrTone, 'draft'>, React.JSX.Element> = {
  failing: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  conflict: <path d="M8 3.2v6.2M8 12.6v.2" />,
  closed: <path d="M11.5 4.5l-7 7" />,
  pending: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 8V2.5A5.5 5.5 0 0 1 13.5 8Z" fill="currentColor" stroke="none" />
    </>
  ),
  blocked: <path d="M4.2 6.2A4.5 4.5 0 1 1 3.6 9.6M4.2 2.8v3.4h3.4" />,
  review: <path d="M3.2 8.6l3 2.9L12.8 4.8" />,
  ready: <path d="M1.5 8.8l2.6 2.6L9.6 5M7.2 11.1l.3.3L14.5 5" />,
  merged: (
    <>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="8.5" r="1.6" />
      <path d="M4.5 5.1v5.8M4.5 5.6c0 2.2 2.4 2.9 5.4 2.9" />
    </>
  ),
  unknown: (
    <>
      <circle cx="3.5" cy="8" r=".9" fill="currentColor" />
      <circle cx="8" cy="8" r=".9" fill="currentColor" />
      <circle cx="12.5" cy="8" r=".9" fill="currentColor" />
    </>
  ),
}

export function PrToneGlyph({
  tone,
  size = 10,
  className,
}: {
  tone: PrTone
  size?: number
  className?: string
}): React.JSX.Element | null {
  if (tone === 'draft') return null
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={tone === 'conflict' ? 2.4 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-glyph={tone}
      className={className}
    >
      {PATHS[tone]}
    </svg>
  )
}

/**
 * A bead's colours per tone: a soft ground and a tinted 1px border, legible on
 * every row ground (sidebar, hover, active) in both themes.
 */
export const PR_TONE_BEAD_CLASSES: Record<PrTone, string> = {
  failing: 'text-danger bg-danger-soft border-danger/40',
  conflict: 'text-danger bg-danger-soft border-danger/40',
  closed: 'text-danger bg-danger-soft border-danger/40',
  pending: 'text-warning bg-warning/10 border-warning/40',
  blocked: 'text-warning bg-warning/10 border-warning/40',
  review: 'text-success bg-success/10 border-success/40',
  ready: 'text-success bg-success/15 border-success/60',
  draft: 'text-text-tertiary bg-chip border-dashed border-text-tertiary',
  merged: 'text-merged bg-merged-soft border-merged/40',
  unknown: 'text-text-tertiary border-border-strong bg-transparent',
}
