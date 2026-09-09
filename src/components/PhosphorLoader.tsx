import { memo } from 'react'
import clsx from 'clsx'

/**
 * Phosphor Beacon: a steady nucleus and an orbiting signal, not a progress
 * gauge. Shared by active lanes, agent activity and app startup. Motion uses
 * only transform/opacity; reduced motion retains the complete, legible mark.
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
        <circle className="phosphor-loader-shell" cx="16" cy="16" r="11" />
        <circle className="phosphor-loader-inner" cx="16" cy="16" r="6" />
        <circle className="phosphor-loader-core" cx="16" cy="16" r="3" />
        <g className="phosphor-loader-orbit">
          <path d="M5 16a11 11 0 0 1 11-11" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="16" cy="5" r="2.5" fill="currentColor" stroke="none" />
        </g>
      </svg>
    </span>
  )
})
