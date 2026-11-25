import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import type { Walk } from '../screen/walk'

/** The steps shown at most: older ones fold into "…". */
const SHOWN = 6

/**
 * The walk above the map: where it started, then each relationship followed as a sentence.
 * Back and Forward, or `[` and `]` on the page, step through it.
 */
export function WalkTrail({
  walk,
  start,
  onMove,
  onJump,
}: {
  walk: Walk
  /** Where the map is when nothing was walked yet. */
  start: string | null
  onMove: (delta: number) => void
  onJump: (index: number) => void
}): React.JSX.Element {
  const first = Math.max(0, walk.steps.length - SHOWN)
  return (
    <nav aria-label="Walk" className="brain-walk">
      <TooltipButton
        aria-label="Back"
        tooltip={{ label: 'Back', shortcut: ['['] }}
        className="brain-icon"
        disabled={walk.index <= 0}
        onClick={() => onMove(-1)}
      >
        ←
      </TooltipButton>
      <TooltipButton
        aria-label="Forward"
        tooltip={{ label: 'Forward', shortcut: [']'] }}
        className="brain-icon"
        disabled={walk.index >= walk.steps.length - 1}
        onClick={() => onMove(1)}
      >
        →
      </TooltipButton>
      {first > 0 && <span className="text-text-tertiary">…</span>}
      <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5">
        {walk.index < 0
          ? start && (
              <li>
                <span aria-current="step" className="brain-walk-step brain-walk-step--current">
                  {start}
                </span>
              </li>
            )
          : walk.steps.slice(first).map((step, offset) => {
              const index = first + offset
              return (
                <li key={index} className="flex min-w-0 items-center gap-1">
                  <TooltipButton
                    tooltip={false}
                    aria-current={index === walk.index ? 'step' : undefined}
                    className={clsx(
                      'brain-walk-step',
                      index === walk.index && 'brain-walk-step--current',
                      index > walk.index && 'brain-walk-step--ahead',
                    )}
                    onClick={() => onJump(index)}
                  >
                    {step.sentence ?? step.label}
                  </TooltipButton>
                </li>
              )
            })}
      </ol>
    </nav>
  )
}
