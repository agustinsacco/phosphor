import { formatTokens } from '@/lib/format'
import { useLiveStats } from '@/stores/laneLiveState'
import { ContextMeter } from './ContextMeter'

/**
 * The live meter at its widest: a percentage over budget, the largest
 * supported context budget (999.9k formats as `1000k`, wider than `1.0M`)
 * and a burn rate of as many characters. Digits are tabular.
 */
const WIDEST_TOKENS = formatTokens(999_900)
const WIDEST_READING = `999% of ${WIDEST_TOKENS}`
const WIDEST_BURN = `${WIDEST_TOKENS}/min`
/** The ring and its readout, in the meter's own spacing. */
const READOUT = 'flex items-center gap-1 whitespace-nowrap px-1 py-0.5'

function Ring(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--px-border-strong)" strokeWidth="2" />
    </svg>
  )
}

/**
 * The status strip's context readout. A lane with no live pi (stopped, or
 * still starting, on its Host, or resumed but not yet measured by its new pi:
 * `useLiveStats`) has nothing to measure, so an empty ring keeps the meter's
 * place, without its popover. The slot is fixed: an invisible copy of the
 * live meter at its widest sizes it, and whichever state shows sits over it
 * out of flow, so stopping, starting or usage arriving never moves the
 * readouts after it, nor wraps the strip. Only the inline readouts keep to
 * one line; the meter's usage popover, which opens from inside the slot,
 * wraps as it always has.
 */
export function ContextReadout({ sessionId }: { sessionId: string }): React.JSX.Element {
  const live = useLiveStats(sessionId) !== null
  return (
    <div data-testid="context-readout" className="relative">
      <span data-readout-reserve aria-hidden="true" className={`invisible ${READOUT}`}>
        <Ring />
        <span className="tabular-nums">{WIDEST_READING}</span>
        <span className="text-2xs font-mono uppercase tracking-wide">{WIDEST_BURN}</span>
      </span>
      <div data-readout-layer className="absolute inset-y-0 left-0 flex items-center">
        {live ? (
          <ContextMeter sessionId={sessionId} />
        ) : (
          <span
            data-testid="context-meter-idle"
            role="img"
            aria-label="Context: starts with the lane"
            data-tooltip="Context: starts with the lane"
            className={READOUT}
          >
            <Ring />
            <span className="tabular-nums">—</span>
          </span>
        )}
      </div>
    </div>
  )
}
