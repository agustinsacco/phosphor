import { useMemo, useState } from 'react'
import { DateTime } from 'luxon'
import {
  activeRun,
  routinePeriod,
  RUN_LABELS,
  type Routine,
  type RoutineRun,
} from '@shared/routines'
import { Button } from '@/components/form'
import { Markdown } from '@/components/markdown/Markdown'
import {
  ALL_RUNS,
  filterRuns,
  groupRunsByDay,
  isFailure,
  runWorkspace,
  type ActivityFilter,
} from './runGroups'

function time(at: number | null, zone: string): string {
  return at === null ? '—' : DateTime.fromMillis(at, { zone }).toFormat('ccc, dd LLL · HH:mm ZZZZ')
}

interface ActivityProps {
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
    `rounded-full border px-3 py-1 ${active ? 'border-accent text-accent' : 'border-border text-text-secondary'}`

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {!routineId && routines.length > 1 && (
          <select
            aria-label="Filter by routine"
            className="border-border bg-surface rounded-lg border px-2 py-1"
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
            className="border-border bg-surface max-w-56 rounded-lg border px-2 py-1"
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
        <p className="text-text-secondary">
          {runs.length
            ? 'No runs match these filters.'
            : 'No runs yet. Save with unattended access acknowledged, then use Run now for a real test.'}
        </p>
      )}
      {days.map((day, index) => {
        const expanded = !(closed[day.key] ?? index > 0)
        return (
          <section key={day.key} className="mb-3">
            <button
              aria-expanded={expanded}
              className="border-border hover:bg-bg-secondary flex w-full items-center justify-between rounded-lg border px-4 py-2 text-left"
              onClick={() => setClosed({ ...closed, [day.key]: expanded })}
            >
              <strong>{day.label}</strong>
              <span className="text-text-secondary">
                {day.runs.length} {day.runs.length === 1 ? 'run' : 'runs'}
                {day.runs.some(isFailure) ? ' · needs a look' : ''}
              </span>
            </button>
            {expanded &&
              day.runs.map((run) => {
                const zone = run.definition.timezone
                const period = routinePeriod(run.definition, run.scheduledAt)
                return (
                  <div
                    key={run.id}
                    data-testid="routine-run"
                    className="border-border mt-2 rounded-lg border p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <strong className={isFailure(run) ? 'text-warning' : undefined}>
                          {RUN_LABELS[run.status]}
                        </strong>
                        <p className="text-text-secondary mt-1">
                          {!routineId && `${run.definition.name} · `}
                          {time(run.scheduledAt, zone)} · {run.trigger}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={busy || (!run.sessionId && !run.sessionPath)}
                          onClick={() => onContinue(run)}
                        >
                          {activeRun(run) ? 'Open running lane' : 'Continue lane'}
                        </Button>
                        {activeRun(run) && (
                          <Button size="sm" disabled={busy} onClick={() => onCancel(run)}>
                            Cancel run
                          </Button>
                        )}
                      </div>
                    </div>
                    <p className="mt-2">
                      {run.reason ||
                        (run.status === 'queued'
                          ? 'Waiting for an available routine worker.'
                          : 'Executing saved instructions…')}
                    </p>
                    <button
                      aria-expanded={open[run.id] ?? false}
                      className="text-text-secondary mt-2"
                      onClick={() => setOpen({ ...open, [run.id]: !open[run.id] })}
                    >
                      {open[run.id] ? 'Hide' : 'Show'} run details and result
                    </button>
                    {open[run.id] && (
                      <div className="mt-3 space-y-2">
                        <p>
                          Started {time(run.startedAt, zone)} · Ended {time(run.endedAt, zone)}
                        </p>
                        <p>
                          Reporting period:{' '}
                          {period
                            ? `${period.start} → ${period.end} (end exclusive)`
                            : 'From instructions'}
                        </p>
                        <p className="break-all">
                          Run {run.id} · Revision {run.definition.revision}
                          <br />
                          {runWorkspace(run)}
                          <br />
                          {run.branch && `Branch ${run.branch}`}
                          {run.baseCommit && ` · Base ${run.baseCommit}`}
                        </p>
                        <p>
                          Model {run.definition.provider}/{run.definition.model}
                          {run.accountId ? ` · Account ${run.accountId}` : ''}
                        </p>
                        <details>
                          <summary className="cursor-pointer">
                            Instructions used for this run
                          </summary>
                          <p className="mt-2 whitespace-pre-wrap">{run.definition.instructions}</p>
                        </details>
                        {run.summary && <Markdown text={run.summary} />}
                      </div>
                    )}
                  </div>
                )
              })}
          </section>
        )
      })}
      {footer}
    </>
  )
}
