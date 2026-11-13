import clsx from 'clsx'
import type { GhPrSummary, GhPullRequest } from '@shared/models'
import { prStages, type StageState } from '../prVerdict'
import './prInspector.css'

/**
 * How far a PR has got: Opened, Checks, Review, Merge. The pill draws four
 * bare segments; the Overview labels each. Both read `prStages`, so they and
 * every other PR surface agree.
 */
const SEGMENT: Record<StageState, string> = {
  done: 'bg-success',
  fail: 'bg-danger',
  run: 'pr-rail-run',
  part: 'pr-rail-part',
  wait: 'bg-border-strong',
  unknown: 'bg-border-strong',
  ready: 'bg-success opacity-55',
}

const BAR: Record<StageState, string> = {
  done: 'border-success',
  fail: 'border-danger',
  run: 'border-warning pr-lrail-run',
  part: 'pr-lrail-part',
  wait: 'border-border-strong',
  unknown: 'border-border-strong',
  ready: 'border-success/55',
}

type AnyPr = GhPullRequest | GhPrSummary

/** "Opened: done, Checks: blocked, …": the rail in words, for a tooltip. */
export function stagesText(pr: AnyPr): string {
  return prStages(pr)
    .map((stage) => `${stage.label}: ${stage.detail}`)
    .join(', ')
}

export function PrRail({ pr }: { pr: AnyPr }): React.JSX.Element {
  return (
    <span className="flex shrink-0 gap-0.5" aria-hidden="true" data-testid="pr-rail">
      {prStages(pr).map((stage) => (
        <i
          key={stage.label}
          data-state={stage.state}
          className={clsx('block h-1 w-[13px] rounded-sm', SEGMENT[stage.state])}
        />
      ))}
    </span>
  )
}

export function PrLabelledRail({ pr }: { pr: AnyPr }): React.JSX.Element {
  return (
    <ol className="grid grid-cols-4 gap-1" aria-label="Progress">
      {prStages(pr).map((stage) => (
        <li
          key={stage.label}
          data-state={stage.state}
          className={clsx('border-t-[3px] pt-1 text-sm leading-tight', BAR[stage.state])}
        >
          <b className="text-text block font-semibold">{stage.label}</b>
          <span className="text-text-secondary">{stage.detail}</span>
        </li>
      ))}
    </ol>
  )
}
