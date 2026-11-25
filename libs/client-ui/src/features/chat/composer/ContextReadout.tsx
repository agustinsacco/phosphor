import { useChatStore } from '@/stores/chat'
import { laneWithoutPi } from '@/stores/hostLaneOf'
import { useSessionHostLane } from '@/stores/remoteLanes'
import { ContextMeter } from './ContextMeter'

/** The live readout's usual widest text: both states take at least its width. */
const RESERVED = '100% of 200k'
/** The ring and its readout, in the meter's own spacing. */
const READOUT = 'flex items-center gap-1 px-1 py-0.5'
const STACKED = 'col-start-1 row-start-1'

function Ring(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--px-border-strong)" strokeWidth="2" />
    </svg>
  )
}

/**
 * The status strip's context readout. A lane with no live pi (stopped, or
 * still starting, on its Host; or no usage reported yet) has nothing to
 * measure, so an empty ring keeps the meter's place, without its popover, even
 * when the chat store still holds an earlier pi's usage. Both states sit over
 * an invisible copy of the widest usual readout, so usage arriving or leaving
 * moves nothing else in the strip, nor makes it wrap.
 */
export function ContextReadout({ sessionId }: { sessionId: string }): React.JSX.Element {
  const measured = useChatStore((s) => !!s.sessions[sessionId]?.stats)
  const hostLane = useSessionHostLane(sessionId)
  const live = measured && !laneWithoutPi(hostLane?.lane)
  return (
    <div data-testid="context-readout" className="grid">
      <span data-readout-reserve aria-hidden="true" className={`invisible ${STACKED} ${READOUT}`}>
        <Ring />
        <span className="tabular-nums">{RESERVED}</span>
      </span>
      <div className={STACKED}>
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
