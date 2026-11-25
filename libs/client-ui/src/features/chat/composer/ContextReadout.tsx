import { formatTokens } from '@/lib/format'
import { useChatStore } from '@/stores/chat'
import { laneWithoutPi } from '@/stores/hostLaneOf'
import { useSessionHostLane } from '@/stores/remoteLanes'
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

function Ring({ percent }: { percent?: number }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--px-border-strong)" strokeWidth="2" />
      {percent !== undefined && (
        <circle
          cx="8"
          cy="8"
          r="6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          pathLength="100"
          strokeDasharray={`${Math.min(100, percent)} 100`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  )
}

/**
 * Live and saved readings share a fixed slot. Only live stats open the usage popover.
 */
export function ContextReadout({ sessionId }: { sessionId: string }): React.JSX.Element {
  const measured = useChatStore((s) => !!s.sessions[sessionId]?.stats)
  const hostLane = useSessionHostLane(sessionId)
  const stopped = laneWithoutPi(hostLane?.lane)
  const saved = stopped ? hostLane?.lane?.stoppedComposer : undefined
  const { tokens, contextWindow } = saved ?? {}
  const percent = tokens !== undefined && contextWindow ? (tokens / contextWindow) * 100 : undefined
  const recorded =
    percent !== undefined && contextWindow
      ? `${Math.round(percent)}% of ${formatTokens(contextWindow)}`
      : tokens !== undefined
        ? `${formatTokens(tokens)} used`
        : contextWindow
          ? `${formatTokens(contextWindow)} window`
          : undefined
  return (
    <div data-testid="context-readout" className="relative">
      <span data-readout-reserve aria-hidden="true" className={`invisible ${READOUT}`}>
        <Ring />
        <span className="tabular-nums">{WIDEST_READING}</span>
        <span className="text-2xs font-mono uppercase tracking-wide">{WIDEST_BURN}</span>
      </span>
      <div data-readout-layer className="absolute inset-y-0 left-0 flex items-center">
        {measured && !stopped ? (
          <ContextMeter sessionId={sessionId} />
        ) : (
          <span
            data-testid={recorded ? 'context-meter-recorded' : 'context-meter-idle'}
            role="img"
            aria-label={
              recorded ? `Last known context: ${recorded}` : 'Context: starts with the lane'
            }
            data-tooltip={
              recorded ? `Last known context: ${recorded}` : 'Context: starts with the lane'
            }
            className={READOUT}
          >
            <Ring percent={percent} />
            <span className="tabular-nums">{recorded ?? '—'}</span>
          </span>
        )}
      </div>
    </div>
  )
}
