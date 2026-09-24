import { useEffect, useState } from 'react'
import { DateTime } from 'luxon'
import clsx from 'clsx'
import type { Routine, RoutineRun } from '@shared/routines'
import { Button } from '@/components/form'
import { showMenuBelow } from '@/components/ContextMenu'
import { MoreIcon } from '@/components/icons'
import { useModelCatalogueStore } from '@/stores/modelCatalogue'
import { ActivityAccordion } from './ActivityAccordion'

const EYEBROW = 'text-text-tertiary font-mono text-xs uppercase tracking-wide'
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function time(at: number | null, zone: string): string {
  return at === null ? '—' : DateTime.fromMillis(at, { zone }).toFormat('ccc, dd LLL · HH:mm ZZZZ')
}

export function scheduleLabel(r: Routine): string {
  if (r.archived) return 'Archived'
  if (r.attention) return 'Needs attention'
  if (!r.enabled) return 'Paused'
  if (r.schedule.kind === 'manual') return 'Manual only'
  if (r.nextAt === null) return 'Schedule complete'
  return `Next ${time(r.nextAt, r.timezone)}`
}

/** Colour of the status dot beside a routine's name. */
export function routineTone(r: Routine, running: boolean): string {
  if (r.attention) return 'bg-warning'
  if (running) return 'bg-accent'
  if (r.enabled && !r.archived) return 'bg-success'
  return 'bg-text-tertiary'
}

/**
 * The schedule in words, for the shapes the editor's presets produce. Anything
 * else is shown as the cron expression itself rather than guessed at.
 */
function describeSchedule(r: Routine): string {
  const s = r.schedule
  if (s.kind === 'manual') return 'Only when you press Run now'
  if (s.kind === 'once') return `Once · ${time(s.at, r.timezone)}`
  const [minute, hour, day, month, weekday] = s.expression.split(/\s+/)
  const at = `${hour?.padStart(2, '0')}:${minute?.padStart(2, '0')}`
  const plain = (v?: string): boolean => !!v && /^\d+$/.test(v)
  if (plain(minute) && hour === '*' && day === '*' && month === '*' && weekday === '*')
    return `Hourly at :${minute!.padStart(2, '0')}`
  if (plain(minute) && plain(hour) && month === '*') {
    if (day === '*' && weekday === '*') return `Daily at ${at}`
    if (day === '*' && weekday === '1-5') return `Weekdays at ${at}`
    if (day === '*' && plain(weekday) && WEEKDAYS[Number(weekday) % 7])
      return `${WEEKDAYS[Number(weekday) % 7]}s at ${at}`
    if (plain(day) && weekday === '*') return `Monthly on day ${day} at ${at}`
  }
  return `Cron ${s.expression}`
}

interface RoutineDetailProps {
  routine: Routine
  history: RoutineRun[]
  /** Whether any run of this routine is queued or running right now. */
  running: boolean
  busy: boolean
  /** Whether a further page of history may exist. */
  more: boolean
  onBack: () => void
  onRun: () => void
  onPause: () => void
  onReview: () => void
  onEdit: () => void
  onSkipNext: () => void
  onDuplicate: () => void
  onExport: () => void
  onArchive: () => void
  onDelete: () => void
  onContinue: (run: RoutineRun) => void
  onCancel: (run: RoutineRun) => void
  onLoadMore: () => void
}

/**
 * One routine: what it is set to do, then every lane it has run.
 *
 * The settings read as a single definition list — the same facts the editor
 * asks for, in the same order — so it is obvious what Edit would change. Only
 * the two actions you reach for (Run now, Edit) are buttons; everything else
 * sits in the "⋯" menu, with the destructive ones last.
 */
export function RoutineDetail(props: RoutineDetailProps): React.JSX.Element {
  const { routine, history, running, busy } = props
  const models = useModelCatalogueStore((s) => s.models)
  useEffect(() => {
    void useModelCatalogueStore.getState().hydrate()
  }, [])
  const model = models.find((m) => m.id === routine.model && m.provider === routine.provider)
  const [instructions, setInstructions] = useState(false)
  const long = routine.instructions.split('\n').length > 4 || routine.instructions.length > 320

  const menu = (anchor: HTMLElement): void =>
    showMenuBelow(anchor, [
      ...(routine.archived
        ? []
        : [
            routine.enabled
              ? { label: 'Pause', hint: 'no new runs', disabled: busy, onClick: props.onPause }
              : { label: 'Review and enable', disabled: busy, onClick: props.onReview },
            {
              label: 'Skip next run',
              disabled: busy || routine.nextAt === null,
              onClick: props.onSkipNext,
            },
          ]),
      { label: 'Duplicate', separatorAbove: !routine.archived, onClick: props.onDuplicate },
      { label: 'Export', hint: 'as JSON', onClick: props.onExport },
      ...(routine.archived
        ? []
        : [
            {
              label: 'Archive',
              hint: 'keeps history',
              separatorAbove: true,
              disabled: busy,
              onClick: props.onArchive,
            },
          ]),
      {
        label: 'Delete…',
        danger: true,
        separatorAbove: routine.archived,
        disabled: busy || running,
        onClick: props.onDelete,
      },
    ])

  return (
    <>
      <button className="text-text-secondary hover:text-text mb-3 text-sm" onClick={props.onBack}>
        ← Routines
      </button>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold">
            <span
              aria-hidden
              className={clsx('size-2.5 shrink-0 rounded-full', routineTone(routine, running))}
            />
            <span className="min-w-0 truncate">{routine.name}</span>
          </h1>
          <p className={clsx('mt-1', routine.attention ? 'text-warning' : 'text-text-secondary')}>
            {running ? 'Running now · ' : ''}
            {scheduleLabel(routine)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!routine.archived && (
            <>
              <Button
                variant="primary"
                disabled={busy || !routine.trusted || !!routine.attention}
                title={routine.trusted ? undefined : 'Acknowledge unattended access in Edit first.'}
                onClick={props.onRun}
              >
                {running ? 'Run already active' : 'Run now'}
              </Button>
              <Button disabled={busy} onClick={props.onEdit}>
                Edit
              </Button>
            </>
          )}
          <button
            aria-label="More actions"
            aria-haspopup="menu"
            title="More actions"
            className="border-border hover:bg-bg-secondary text-text-secondary hover:text-text flex items-center self-stretch rounded-md border px-2 transition-colors"
            onClick={(e) => menu(e.currentTarget)}
          >
            <MoreIcon />
          </button>
        </div>
      </header>
      {routine.attention && (
        <p role="alert" className="border-warning text-warning mb-4 rounded-lg border p-3">
          {routine.attention}
        </p>
      )}
      <section
        aria-label="Routine settings"
        className="border-border bg-surface mb-8 rounded-lg border"
      >
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-3">
          <Setting label="Schedule">
            {describeSchedule(routine)}
            {routine.schedule.kind !== 'manual' && (
              <span className="text-text-tertiary"> · {routine.timezone}</span>
            )}
          </Setting>
          <Setting label="Model">
            {model?.name ?? routine.model}{' '}
            <span className="text-text-tertiary font-mono text-sm">{routine.provider}</span>
          </Setting>
          <Setting label="Workspace">
            <span className="break-all">{routine.workspacePath}</span>
          </Setting>
          <Setting label="Runs as">
            {routine.isolated ? 'Fresh worktree' : 'Folder task'} ·{' '}
            {routine.intent === 'code' ? 'code change' : 'report'}
            {routine.period !== 'none' && (
              <span className="text-text-tertiary">
                {' '}
                · covers the {routine.period === 'previous-day' ? 'previous day' : 'previous week'}
              </span>
            )}
          </Setting>
          <Setting label="Limits">
            Stops after {routine.maxRuntimeMinutes} min
            {routine.schedule.kind !== 'manual' &&
              ` · catches up a missed run within ${routine.catchUpHours} h`}
          </Setting>
          <Setting label="Revision">
            {routine.revision}
            <span className="text-text-tertiary">
              {' '}
              · saved {DateTime.fromMillis(routine.updatedAt).toRelative()}
            </span>
          </Setting>
        </dl>
        <div className="border-border border-t px-4 py-3">
          <p className={clsx(EYEBROW, 'mb-1.5')}>Instructions</p>
          <p className={clsx('whitespace-pre-wrap', long && !instructions && 'line-clamp-4')}>
            {routine.instructions}
          </p>
          {long && (
            <button
              aria-expanded={instructions}
              className="text-text-secondary hover:text-text mt-1 text-sm"
              onClick={() => setInstructions(!instructions)}
            >
              {instructions ? 'Show less' : 'Show all'}
            </button>
          )}
        </div>
      </section>
      <ActivityAccordion
        heading={
          <>
            <h2 className="text-lg font-semibold">Runs</h2>
            <p className="text-text-tertiary text-sm">
              Finished means a written result, not verified claims. A retry can repeat external
              changes.
            </p>
          </>
        }
        runs={history}
        routines={[routine]}
        routineId={routine.id}
        busy={busy}
        onContinue={props.onContinue}
        onCancel={props.onCancel}
        footer={
          props.more && (
            <Button size="sm" disabled={busy} onClick={props.onLoadMore}>
              Load older runs
            </Button>
          )
        }
      />
    </>
  )
}

function Setting({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <dt className={clsx(EYEBROW, 'pt-1')}>{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}
