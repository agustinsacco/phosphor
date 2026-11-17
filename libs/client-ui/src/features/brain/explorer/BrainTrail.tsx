import { TooltipButton } from '@/components/Tooltip'
import type { BrainTrail as Trail } from './trail'
export function BrainTrail({
  trail,
  onMove,
  onJump,
}: {
  trail: Trail
  onMove: (delta: number) => void
  onJump: (index: number) => void
}): React.JSX.Element {
  // Keep Forward reachable from Overview after clearing the selection.
  if (!trail.items.length) return <></>
  const start = Math.max(0, trail.index - 2)
  return (
    <nav
      aria-label="Brain trail"
      className="text-text-secondary flex min-w-0 flex-wrap items-center gap-1 py-2 text-sm"
    >
      <TooltipButton
        aria-label="Back"
        tooltip="Back · Alt+← / Backspace"
        className="graph-icon"
        disabled={trail.index < 0}
        onClick={() => onMove(-1)}
      >
        ←
      </TooltipButton>
      <TooltipButton
        aria-label="Forward"
        tooltip="Forward · Alt+→"
        className="graph-icon"
        disabled={trail.index >= trail.items.length - 1}
        onClick={() => onMove(1)}
      >
        →
      </TooltipButton>
      <TooltipButton
        className="hover:text-text hover:underline"
        aria-current={trail.index < 0 ? 'page' : undefined}
        onClick={() => onJump(-1)}
      >
        Overview
      </TooltipButton>
      {start > 0 && <span aria-label="Earlier steps">› …</span>}
      {trail.items.slice(start, trail.index + 1).map((visit, offset) => (
        <span key={start + offset} className="flex min-w-0 items-start gap-1">
          <span aria-hidden="true">›</span>
          {start + offset === trail.index ? (
            <span aria-current="page">{visit.kind === 'memory' ? 'Memory' : visit.label}</span>
          ) : (
            <TooltipButton
              className="min-w-0 text-left hover:underline [overflow-wrap:anywhere]"
              onClick={() => onJump(start + offset)}
            >
              {visit.kind === 'memory' ? 'Memory' : visit.label}
            </TooltipButton>
          )}
        </span>
      ))}
    </nav>
  )
}
