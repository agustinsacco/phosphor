import { useMemo, useState } from 'react'
import { DateTime } from 'luxon'
import clsx from 'clsx'
import {
  activeRun,
  routinePeriod,
  RUN_LABELS,
  type Routine,
  type RoutineRun,
} from '@shared/routines'
import { Button } from '@/components/form'
import { ChevronIcon } from '@/components/icons'
import { Markdown } from '@/components/markdown/Markdown'
import {
  ALL_RUNS,
  filterRuns,
  groupRunsByDay,
  isFailure,
  runWorkspace,
  type ActivityFilter,
} from './runGroups'

const EYEBROW = 'text-text-tertiary font-mono text-xs uppercase tracking-wide'

function time(at: number | null, zone: string): string {
  return at === null ? '—' : DateTime.fromMillis(at, { zone }).toFormat('ccc, dd LLL · HH:mm ZZZZ')
}

/** The day is the group heading already; a row only needs the clock. */
function clock(at: number, zone: string): string {
  return DateTime.fromMillis(at, { zone }).toFormat('HH:mm ZZZZ')
}

/** Colour of a run row's status dot. */
function runTone(run: RoutineRun): string {
  if (activeRun(run)) return 'bg-accent'
  if (run.status === 'finished') return 'bg-success'
  if (run.status === 'skipped' || run.status === 'cancelled') return 'bg-text-tertiary'
  return 'bg-warning'
}

interface ActivityProps {
  /** Rendered on the filter row's left, so heading and filters share a line. */
  heading: React.ReactNode
  runs: RoutineRun[]
  /** Named so a run row can say which routine produced it in the global list. */
  routines: Routine[]
  /** Set when this list sits inside one routine: its own filter is then fixed. */
  routineId?: string
  busy: boolean
  onContinue: (run: RoutineRun) => void
  onCancel: (run: RoutineRun) => void
  /** Rendered under the last day, for the routine detail's pagination. */
  footer?: React.ReactNode
}

/**
 * Every routine lane, grouped by the day it ran.
 *
 * This is where a routine's lanes live now that they are not in the sidebar, so
 * it has to answer "what has run lately" without making you open each routine
 * first. Days collapse; the most recent one starts open, because a routine you
 * just triggered is the one you came here to read.
 */
export function ActivityAccordion({
  heading,
  runs,
  routines,
  routineId,
  busy,
  onContinue,
  onCancel,
  footer,
}: ActivityProps): React.JSX.Element {
  const [filter, setFilter] = useState<ActivityFilter>(ALL_RUNS)
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const workspaces = useMemo(
    () => [...new Set(runs.map(runWorkspace))].sort((a, b) => a.localeCompare(b)),
    [runs],
  )
  const days = useMemo(
    () => groupRunsByDay(filterRuns(runs, { ...filter, routineId: routineId ?? filter.routineId })),
    [runs, filter, routineId],
  )
  const chip = (active: boolean): string =>
    clsx(
      'rounded-full border px-2.5 py-0.5 text-sm transition-colors',
      active
        ? 'border-accent text-accent'
        : 'border-border text-text-secondary hover:text-text hover:bg-bg-secondary',
    )
  const select = 'border-border bg-surface max-w-48 rounded-full border px-2 py-0.5 text-sm'

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="mr-auto">{heading}</div>
        {!routineId && routines.length > 1 && (
          <select
            aria-label="Filter by routine"
            className={select}
            value={filter.routineId ?? ''}
            onChange={(e) => setFilter({ ...filter, routineId: e.target.value || null })}
          >
            <option value="">All routines</option>
            {routines.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        {workspaces.length > 1 && (
          <select
            aria-label="Filter by workspace"
            className={select}
            value={filter.workspacePath ?? ''}
            onChange={(e) => setFilter({ ...filter, workspacePath: e.target.value || null })}
          >
            <option value="">All workspaces</option>
            {workspaces.map((path) => (
              <option key={path} value={path}>
                {path.split('/').slice(-2).join('/')}
              </option>
            ))}
          </select>
        )}
        {(['scheduled', 'one-off'] as const).map((trigger) => (
          <button
            key={trigger}
            aria-pressed={filter.trigger === trigger}
            className={chip(filter.trigger === trigger)}
            onClick={() =>
              setFilter({ ...filter, trigger: filter.trigger === trigger ? 'all' : trigger })
            }
          >
            {trigger === 'scheduled' ? 'Scheduled' : 'One-off'}
          </button>
        ))}
        <button
          aria-pressed={filter.failedOnly}
          className={chip(filter.failedOnly)}
          onClick={() => setFilter({ ...filter, failedOnly: !filter.failedOnly })}
        >
          Failed only
        </button>
      </div>
      {!days.length && (
        <p className="border-border text-text-secondary rounded-lg border border-dashed p-4">
          {runs.length
            ? 'No runs match these filters.'
            : 'No runs yet. Save with unattended access acknowledged, then use Run now for a real test.'}
        </p>
      )}
      {days.map((day, index) => {
        const expanded = !(closed[day.key] ?? index > 0)
        return (
          <section key={day.key} className="mb-4">
            <button
              aria-expanded={expanded}
              className="hover:text-text text-text-secondary flex w-full items-center gap-1.5 py-1 text-left"
              onClick={() => setClosed({ ...closed, [day.key]: expanded })}
            >
              <ChevronIcon expanded={expanded} size={11} />
              <span className="text-text font-medium">{day.label}</span>{' '}
              <span className="text-text-tertiary text-sm">
                {day.runs.length} {day.runs.length === 1 ? 'run' : 'runs'}
                {day.runs.some(isFailure) ? ' · needs a look' : ''}
              </span>
            </button>
            {expanded && (
              <ul className="border-border bg-surface divide-border mt-1 divide-y rounded-lg border">
                {day.runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    global={!routineId}
                    busy={busy}
                    open={open[run.id] ?? false}
                    onToggle={() => setOpen({ ...open, [run.id]: !open[run.id] })}
                    onContinue={() => onContinue(run)}
                    onCancel={() => onCancel(run)}
                  />
                ))}
              </ul>
            )}
          </section>
        )
      })}
      {footer}
    </>
  )
}

function RunRow({
  run,
  global,
  busy,
  open,
  onToggle,
  onContinue,
  onCancel,
}: {
  run: RoutineRun
  /** The Activity list across routines: lead with which routine this was. */
  global: boolean
  busy: boolean
  open: boolean
  onToggle: () => void
  onContinue: () => void
  onCancel: () => void
}): React.JSX.Element {
  const zone = run.definition.timezone
  const period = routinePeriod(run.definition, run.scheduledAt)
  const reason =
    run.reason ||
    (run.status === 'queued'
      ? 'Waiting for an available routine worker.'
      : 'Executing saved instructions…')
  return (
    <li data-testid="routine-run" className="px-4 py-3">
      <div className="flex items-start gap-3">
        <span aria-hidden className={clsx('mt-[7px] size-2 shrink-0 rounded-full', runTone(run))} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {global && <span className="font-medium">{run.definition.name}</span>}
            <strong
              className={clsx(
                global ? 'font-normal' : 'font-medium',
                isFailure(run) && 'text-warning',
              )}
            >
              {RUN_LABELS[run.status]}
            </strong>
            <span className="text-text-tertiary text-sm tabular-nums">
              {clock(run.startedAt ?? run.scheduledAt, zone)} ·{' '}
              {run.trigger === 'manual' ? 'run now' : 'scheduled'}
            </span>
          </div>
          <p className={clsx('text-text-secondary mt-0.5', !open && 'line-clamp-2')}>{reason}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {activeRun(run) && (
            <Button size="sm" disabled={busy} onClick={onCancel}>
              Cancel run
            </Button>
          )}
          <Button
            size="sm"
            disabled={busy || (!run.sessionId && !run.sessionPath)}
            onClick={onContinue}
          >
            {activeRun(run) ? 'Open running lane' : 'Continue lane'}
          </Button>
          <button
            aria-expanded={open}
            aria-label={open ? 'Hide run details' : 'Show run details'}
            title={open ? 'Hide details' : 'Details and result'}
            className="text-text-tertiary hover:text-text hover:bg-bg-secondary rounded-md p-1.5"
            onClick={onToggle}
          >
            <ChevronIcon expanded={open} size={12} />
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-3 space-y-3 pl-5">
          {run.summary && (
            <div className="border-border bg-bg rounded-md border px-3 py-2">
              <p className={clsx(EYEBROW, 'mb-1')}>Result</p>
              <Markdown text={run.summary} />
            </div>
          )}
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1">
            <Detail label="Scheduled">{time(run.scheduledAt, zone)}</Detail>
            <Detail label="Ran">
              {time(run.startedAt, zone)} → {time(run.endedAt, zone)}
            </Detail>
            <Detail label="Model">
              {run.definition.provider}/{run.definition.model}
              {run.accountId ? ` · account ${run.accountId}` : ''}
            </Detail>
            <Detail label="Folder">{runWorkspace(run)}</Detail>
            {run.branch && (
              <Detail label="Branch">
                {run.branch}
                {run.baseCommit && ` · base ${run.baseCommit.slice(0, 12)}`}
              </Detail>
            )}
            {period && (
              <Detail label="Period">
                {period.start} → {period.end} (end exclusive)
              </Detail>
            )}
            <Detail label="Run">
              {run.id} · revision {run.definition.revision}
            </Detail>
          </dl>
          <details>
            <summary className="text-text-secondary hover:text-text cursor-pointer">
              Instructions used for this run
            </summary>
            <p className="mt-2 whitespace-pre-wrap">{run.definition.instructions}</p>
          </details>
        </div>
      )}
    </li>
  )
}

function Detail({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <dt className={clsx(EYEBROW, 'pt-0.5')}>{label}</dt>
      <dd className="text-text-secondary break-all">{children}</dd>
    </>
  )
}
