import { memo } from 'react'
import clsx from 'clsx'
import { BeaconGlyph } from './PhosphorMark'

/**
 * Phosphor Beacon: a steady nucleus and an orbiting signal, not a progress
 * gauge. Shared by active lanes, agent activity and app startup. Motion uses
 * only transform/opacity; reduced motion retains the complete, legible mark.
 *
 * The glyph itself lives in `PhosphorMark` — this is the brand mark with its
 * orbit turning, not a separate drawing. Edit the geometry there.
 */
export const PhosphorLoader = memo(function PhosphorLoader({
  size = 24,
  label = 'Working',
  decorative = false,
  animated = true,
  className,
}: {
  /** 20px in lanes, 24px with activity copy, 80px on the startup screen. */
  size?: number
  label?: string
  decorative?: boolean
  animated?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={clsx('phosphor-loader', className)}
      style={{ width: size, height: size }}
      data-animated={animated}
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
