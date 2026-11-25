import { useChatStore } from '@/stores/chat'
import { ContextMeter } from './ContextMeter'

/**
 * The status strip's context readout. A lane with no live pi yet (stopped, or
 * still starting) has nothing to measure, so an empty ring keeps the meter's
 * place, without its popover, until pi reports usage.
 */
export function ContextReadout({ sessionId }: { sessionId: string }): React.JSX.Element {
  const measured = useChatStore((s) => !!s.sessions[sessionId]?.stats)
  if (measured) return <ContextMeter sessionId={sessionId} />
  return (
    <span
      data-testid="context-meter-idle"
      role="img"
      aria-label="Context: starts with the lane"
      data-tooltip="Context: starts with the lane"
      className="flex items-center gap-1 px-1 py-0.5"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="6.5"
          fill="none"
          stroke="var(--px-border-strong)"
          strokeWidth="2"
        />
      </svg>
      <span className="tabular-nums">—</span>
    </span>
  )
}
