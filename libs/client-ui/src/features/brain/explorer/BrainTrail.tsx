import { Button } from '@/components/form'
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
  return (
    <nav
      aria-label="Brain trail"
      className="border-border flex flex-wrap items-center gap-1 border-b p-3"
    >
      <Button size="xs" disabled={trail.index < 0} onClick={() => onMove(-1)}>
        Back
      </Button>
      <Button size="xs" disabled={trail.index >= trail.items.length - 1} onClick={() => onMove(1)}>
        Forward
      </Button>
      <Button size="xs" onClick={() => onJump(-1)}>
        Overview
      </Button>
      {trail.items.map((visit, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          <span aria-hidden="true">›</span>
          <Button
            size="xs"
            className="max-w-48 truncate"
            aria-current={i === trail.index ? 'page' : undefined}
            onClick={() => onJump(i)}
          >
            {visit.label}
          </Button>
        </span>
      ))}
    </nav>
  )
}
