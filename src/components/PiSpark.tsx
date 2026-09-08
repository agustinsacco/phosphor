import { memo } from 'react'
import clsx from 'clsx'

/**
 * The "pi is working" mark.
 *
 * An eight-ray spark in the Phosphor accent, drawn rather than typed — the
 * previous placeholder was a literal ✳ glyph whose only motion was an
 * opacity blink, so it read as a flashing character instead of a living
 * indicator.
 *
 * Rays animate on staggered delays (scale + opacity) while the whole mark
 * rotates slowly, which gives the shimmering-outward feel of the reference
 * without a hard spinner. Motion is CSS-driven so the global
 * prefers-reduced-motion rule disables it.
 */
export const PiSpark = memo(function PiSpark({
  size = 20,
  className,
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={clsx('pi-spark', className)}
      role="img"
      aria-label="pi is working"
    >
      <g
        stroke="var(--px-accent)"
        strokeWidth="2"
        strokeLinecap="round"
        className="pi-spark-rays"
        style={{ transformOrigin: '12px 12px' }}
      >
        {/* Four long rays on the axes, four short ones on the diagonals. */}
        <line
          className="pi-spark-ray"
          style={{ animationDelay: '0ms' }}
          x1="12"
          y1="2.5"
          x2="12"
          y2="7.5"
        />
        <line
          className="pi-spark-ray"
          style={{ animationDelay: '110ms' }}
          x1="21.5"
          y1="12"
          x2="16.5"
          y2="12"
        />
        <line
          className="pi-spark-ray"
          style={{ animationDelay: '220ms' }}
          x1="12"
          y1="21.5"
          x2="12"
          y2="16.5"
        />
        <line
          className="pi-spark-ray"
          style={{ animationDelay: '330ms' }}
          x1="2.5"
          y1="12"
          x2="7.5"
          y2="12"
        />
        <line
          className="pi-spark-ray"
          style={{ animationDelay: '55ms' }}
          x1="18.7"
          y1="5.3"
          x2="15.6"
          y2="8.4"
          strokeWidth="1.6"
        />
        <line
          className="pi-spark-ray"
          style={{ animationDelay: '165ms' }}
          x1="18.7"
          y1="18.7"
          x2="15.6"
          y2="15.6"
          strokeWidth="1.6"
        />
        <line
          className="pi-spark-ray"
          style={{ animationDelay: '275ms' }}
          x1="5.3"
          y1="18.7"
          x2="8.4"
          y2="15.6"
          strokeWidth="1.6"
        />
        <line
          className="pi-spark-ray"
          style={{ animationDelay: '385ms' }}
          x1="5.3"
          y1="5.3"
          x2="8.4"
          y2="8.4"
          strokeWidth="1.6"
        />
      </g>
    </svg>
  )
})
