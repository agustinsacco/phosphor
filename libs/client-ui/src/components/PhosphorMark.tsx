import { memo } from 'react'
import clsx from 'clsx'

/**
 * The Phosphor mark — a steady nucleus, two faint shells, one orbiting signal.
 *
 * This file owns the geometry for BOTH the brand mark and the working
 * indicator, because they are the same object: `build/icon.svg` is this glyph
 * at `ICON_SCALE`, and `PhosphorLoader` is this glyph with the orbit turning.
 * Three consecutive marks specified an in-app variant that was never built,
 * and the last one let the app icon and the website drift into two different
 * drawings. One glyph with one home is what stops that recurring;
 * `PhosphorMark.test.ts` fails if `build/icon.svg` stops matching.
 *
 * The numbers live here rather than in `index.css` for the same reason —
 * geometry in one place, and the stylesheet left owning only colour and
 * motion.
 */
/** Lengths only — every one of these must stay whole at `ICON_SCALE`. */
export const BEACON = {
  /** Outer shell: the orbit's path. */
  shellR: 11,
  shellStroke: 1.5,
  /** Inner shell: pure depth. First thing to go at 16px, and that is fine. */
  innerR: 6,
  innerStroke: 1,
  /** The nucleus and the orbit head are full-strength — they carry the mark. */
  coreR: 3,
  orbitStroke: 2.5,
  headR: 2.5,
} as const

/**
 * Kept apart from `BEACON` because these are the one thing that does NOT
 * scale with the icon — they are the same number at 16px and at 1024.
 */
export const BEACON_OPACITY = { shell: 0.35, inner: 0.2 } as const

/**
 * 28× maps the 32-unit glyph to 896px, with a 64px inset in the 1024px tile.
 * Chosen because every value above stays an integer at icon scale
 * (11/6/3/1.5/1/2.5 → 308/168/84/42/28/70), so `build/icon.svg` holds no
 * rounded numbers to argue with.
 */
export const ICON_SCALE = 28

/**
 * The contrast hierarchy is the mark: the shells are faint and are ALLOWED to
 * disappear at small sizes, because the nucleus, the orbit and the head are
 * full-strength and carry it alone. The mark before this one inverted that —
 * its concept lived in .10 rings and a 64px caption, and both were gone by
 * 48px.
 */
export const BeaconGlyph = memo(function BeaconGlyph(): React.JSX.Element {
  return (
    <>
      <circle
        cx="16"
        cy="16"
        r={BEACON.shellR}
        strokeWidth={BEACON.shellStroke}
        opacity={BEACON_OPACITY.shell}
      />
      <circle
        cx="16"
        cy="16"
        r={BEACON.innerR}
        strokeWidth={BEACON.innerStroke}
        opacity={BEACON_OPACITY.inner}
      />
      <circle className="phosphor-loader-core" cx="16" cy="16" r={BEACON.coreR} />
      <g className="phosphor-loader-orbit">
        <path
          d={`M${16 - BEACON.shellR} 16a${BEACON.shellR} ${BEACON.shellR} 0 0 1 ${BEACON.shellR} -${BEACON.shellR}`}
          strokeWidth={BEACON.orbitStroke}
          strokeLinecap="round"
        />
        <circle
          cx="16"
          cy={16 - BEACON.shellR}
          r={BEACON.headR}
          fill="currentColor"
          stroke="none"
        />
      </g>
    </>
  )
})

/**
 * The mark at rest, for chrome and About — never animated. Reach for
 * `PhosphorLoader` when the thing being drawn is activity rather than
 * identity; it is this glyph with the orbit turning.
 */
export const PhosphorMark = memo(function PhosphorMark({
  size = 32,
  label = 'Phosphor',
  decorative = false,
  className,
}: {
  size?: number
  label?: string
  /** Set when a visible wordmark already names the app beside it. */
  decorative?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={clsx('phosphor-mark', className)}
      style={{ width: size, height: size }}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
    >
      <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <BeaconGlyph />
      </svg>
    </span>
  )
})

/**
 * Mark plus wordmark, set in the mono face. "Phosphor" is always capitalized.
 *
 * Phrasing content (spans, not divs) so it can sit inside a heading — the
 * About tab uses it as its `<h2>`, and swapping the heading out for a bare
 * lockup would leave that panel with no heading at all.
 */
export function PhosphorLockup({ size = 36 }: { size?: number }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-3 align-middle">
      <PhosphorMark size={size} decorative />
      <span className="font-mono tracking-tight">Phosphor</span>
    </span>
  )
}
