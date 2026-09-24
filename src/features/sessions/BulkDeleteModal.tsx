import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { ModalOverlay } from '@/components/Modal'
import { ChevronIcon, Spinner } from '@/components/icons'
import { useSessionsStore } from '@/stores/sessions'
import { prChip } from './prChip'
import { describeWarnings, type PreflightSummary } from './deletePreflight'

/**
 * Confirm for deleting lanes: several at once, or a single row's Delete when
 * that lane is the only session in its own worktree.
 *
 * The single-lane equivalent is `RemoveWorktreeModal`, and the two must agree
 * about what "dirty" blocks — two confirms with different refusal rules is the
 * likely bug in this feature. Both refuse a dirty worktree unless the user
 * opts into discarding, and both delete a branch only when its work is already on the trunk.
 *
 * "Delete a lane" is three resources, and only the first two default on:
 * the session transcript (to the OS Trash, recoverable), the worktree
 * directory (gone), and the branch (only when it is proven merged). Remote branches are
 * deliberately not offered — Phosphor has no channel for it, and a bulk flow is
 * the worst place to introduce the least reversible operation.
 */
export function BulkDeleteModal({
  summary,
  onCancel,
  onConfirm,
}: {
  summary: PreflightSummary
  onCancel: () => void
  onConfirm: (options: {
    removeWorktree: boolean
    deleteBranch: boolean
    discardChanges: boolean
  }) => void
}): React.JSX.Element {
  const [removeWorktree, setRemoveWorktree] = useState(true)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const count = summary.deletable.length
  const hasDirty = summary.deletable.some((lane) => lane.dirtyCount > 0)
  const blocked = summary.needsAcknowledgement && !acknowledged
  const canDelete = count > 0 && !blocked

  return (
    <ModalOverlay onClose={onCancel}>
      <div className="bg-surface-raised border-border w-[min(38rem,94vw)] rounded-lg border shadow-2xl">
        <div className="border-border border-b px-5 py-4">
          <h2 className="text-base font-semibold">
            {count === 1 ? 'Delete lane' : `Delete ${count} lanes`}
          </h2>
          <p className="text-text-secondary mt-1 text-sm">
            Removing a lane can touch three things. Only the first two are on by default.
          </p>
        </div>

        <div className="max-h-64 overflow-y-auto px-5 py-3">
          <div className="border-border divide-border divide-y overflow-hidden rounded-md border">
            {summary.lanes.map((lane) => (
              <div key={lane.path} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="w-[18px] shrink-0 text-center">{lane.marker || '•'}</span>
                <span className="min-w-0 flex-1 truncate">{lane.title}</span>
                {lane.warnings.includes('running') && <Badge tone="warn">will stop</Badge>}
                {lane.dirtyCount > 0 && <Badge tone="warn">±{lane.dirtyCount}</Badge>}
                {lane.warnings.includes('unpushed') && <Badge tone="warn">unpushed</Badge>}
                {lane.pr ? (
                  <Badge tone={prBadgeTone(lane)}>
                    {prChip(lane.pr).label} {lane.pr.state.toLowerCase()}
                  </Badge>
                ) : (
                  <Badge tone="info">no PR</Badge>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-1 px-5 pb-2">
          <Option checked disabled label="Move the session to Trash">
            The pi transcript and its paired Claude Code transcript. Recoverable from the OS Trash.
          </Option>
          <Option
            checked={removeWorktree}
            onChange={setRemoveWorktree}
            label={`Remove the git worktree${
              summary.worktreeCount ? ` (${summary.worktreeCount})` : ''
            }`}
            disabled={summary.worktreeCount === 0}
          >
            {summary.worktreeCount === 0
              ? 'No worktree here is used only by the selected lanes.'
              : 'Deletes the working directory on disk. Not undoable.'}
          </Option>
          <Option
            checked={deleteBranch}
            onChange={setDeleteBranch}
            label="Also delete the branch"
            disabled={!removeWorktree || summary.worktreeCount === 0}
          >
            Deleted when its work is already on the trunk, squash-merged PRs included. An unmerged
            branch is kept and reported, never forced.
          </Option>
        </div>

        {summary.needsAcknowledgement && (
          <div className="px-5 pb-3">
            <label className="border-danger bg-danger-soft flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="accent-accent mt-0.5"
              />
              <span>
                {summary.deletable.length === 1 ? 'This lane' : 'Some of these lanes'} would lose
                work ({describeWarnings(summary.warnings)}). I understand.
              </span>
            </label>
          </div>
        )}

        <div className="border-border bg-bg-secondary flex items-center gap-2 rounded-b-lg border-t px-5 py-3">
          <span className="text-text-tertiary text-xs">
            {removeWorktree && summary.worktreeCount > 0
              ? 'Worktree removal cannot be undone.'
              : 'Transcripts go to the Trash.'}
          </span>
          <span className="flex-1" />
          <button
            onClick={onCancel}
            className="border-border text-text-secondary hover:text-text rounded-md border px-3 py-1 text-sm"
          >
            Cancel
          </button>
          <button
            disabled={!canDelete}
            onClick={() =>
              onConfirm({ removeWorktree, deleteBranch, discardChanges: hasDirty && acknowledged })
            }
            className="bg-danger rounded-md px-3 py-1 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {count === 1 ? 'Delete lane' : `Delete ${count} lanes`}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function prBadgeTone(lane: PreflightSummary['lanes'][number]): 'ok' | 'info' | 'warn' {
  if (lane.pr?.state === 'MERGED') return 'ok'
  if (lane.pr?.state === 'CLOSED') return 'info'
  return 'warn'
}

const TONES = {
  ok: 'bg-success/12 text-success',
  warn: 'bg-warning/12 text-warning',
  bad: 'bg-danger-soft text-danger',
  info: 'bg-info/12 text-info',
} as const

function Badge({
  tone,
  children,
}: {
  tone: keyof typeof TONES
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className={clsx('shrink-0 rounded-full px-2 text-2xs font-semibold', TONES[tone])}>
      {children}
    </span>
  )
}

function Option({
  checked,
  onChange,
  disabled,
  label,
  children,
}: {
  checked: boolean
  onChange?: (next: boolean) => void
  disabled?: boolean
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label
      className={clsx(
        'flex items-start gap-2 py-1.5 text-sm',
        disabled ? 'cursor-default opacity-55' : 'cursor-pointer',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        className="accent-accent mt-0.5"
      />
      <span>
        {label}
        <span className="text-text-tertiary mt-0.5 block text-xs">{children}</span>
      </span>
    </label>
  )
}

const COMPLETE_HOLD_MS = 4_000
const FADE_MS = 250

/**
 * Non-blocking progress for a bulk delete.
 *
 * The confirmation remains a modal because it authorizes destructive work.
 * Once confirmed, progress moves into this fixed notification so the user can
 * keep working. Its compact row expands to retain the per-lane outcomes that
 * matter when a worktree or branch cannot be removed.
 */
export function BulkDeleteProgressPopover(): React.JSX.Element | null {
  const progress = useSessionsStore((s) => s.bulkDelete)
  const [expanded, setExpanded] = useState(false)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    if (!progress) return
    if (progress.running) {
      setFading(false)
      return
    }

    setExpanded(false)
    const fadeTimer = window.setTimeout(() => setFading(true), COMPLETE_HOLD_MS)
    const dismissTimer = window.setTimeout(
      () => useSessionsStore.getState().dismissBulkDelete(),
      COMPLETE_HOLD_MS + FADE_MS,
    )
    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(dismissTimer)
    }
  }, [progress?.running])

  if (!progress) return null

  const { total, done, current, currentPath, lanes, results, running, cancelled } = progress
  const failed = results.filter((r) => !r.ok)
  const warned = results.filter((r) => r.ok && r.error)
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  const byPath = new Map(results.map((result) => [result.path, result]))
  const title = running
    ? cancelled
      ? 'Stopping after current lane…'
      : `Deleting ${Math.min(done + 1, total)} of ${total}`
    : summaryTitle(results.length, failed.length, cancelled)
  const subtitle = running
    ? current || 'Starting…'
    : failed.length > 0
      ? `${failed.length} lane${failed.length === 1 ? '' : 's'} kept`
      : warned.length > 0
        ? 'Complete, with branches kept'
        : 'Complete'

  return createPortal(
    <div className="pointer-events-none fixed left-3 top-14 z-40 w-[min(22rem,calc(100vw-1.5rem))]">
      <section
        data-testid="bulk-delete-progress"
        role="status"
        aria-live="polite"
        className={clsx(
          'bg-surface-raised border-border pointer-events-auto overflow-hidden rounded-lg border shadow-xl transition-[opacity,transform] duration-200',
          fading && '-translate-y-1 opacity-0',
        )}
      >
        <button
          type="button"
          data-testid="bulk-delete-toggle"
          aria-expanded={expanded}
          aria-controls="bulk-delete-details"
          onClick={() => setExpanded((open) => !open)}
          className="hover:bg-bg-secondary flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors"
        >
          <span
            aria-hidden
            className={clsx(
              'flex size-5 shrink-0 items-center justify-center rounded-full',
              running
                ? 'bg-accent-soft text-accent'
                : failed.length > 0
                  ? 'bg-warning/15 text-warning'
                  : 'bg-success/15 text-success',
            )}
          >
            {running ? <Spinner /> : failed.length > 0 ? '!' : '✓'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="text-text block truncate text-sm font-semibold">{title}</span>
            <span className="text-text-secondary block truncate text-xs">{subtitle}</span>
          </span>
          {running && <span className="text-text-tertiary text-xs tabular-nums">{percent}%</span>}
          <ChevronIcon expanded={expanded} className="text-text-tertiary" />
        </button>

        <div className="bg-chip h-1 w-full overflow-hidden">
          <div
            className={clsx(
              'h-full transition-[width] duration-200',
              failed.length > 0 ? 'bg-warning' : running ? 'bg-accent' : 'bg-success',
            )}
            style={{ width: `${running ? Math.max(percent, 4) : 100}%` }}
          />
        </div>

        {expanded && (
          <div id="bulk-delete-details" className="border-border border-t">
            <div className="max-h-56 overflow-y-auto p-2">
              <div className="border-border divide-border divide-y overflow-hidden rounded-md border">
                {lanes.map((lane) => {
                  const result = byPath.get(lane.path)
                  const active = running && !result && lane.path === currentPath
                  return (
                    <div
                      key={lane.path}
                      className={clsx(
                        'flex items-center gap-2 px-2.5 py-2 text-sm',
                        !result && !active && 'opacity-45',
                      )}
                    >
                      <span
                        aria-hidden
                        className={clsx(
                          'w-3 shrink-0 text-center',
                          result
                            ? result.ok
                              ? 'text-success'
                              : 'text-danger'
                            : 'text-text-tertiary',
                        )}
                      >
                        {result ? (result.ok ? '✓' : '✕') : active ? '…' : '·'}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{lane.title}</span>
                      {result?.error && (
                        <span
                          title={result.error}
                          className={clsx(
                            'max-w-40 shrink-0 truncate text-2xs',
                            result.ok ? 'text-warning' : 'text-danger',
                          )}
                        >
                          {result.error}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
              {warned.length > 0 && (
                <p className="text-text-tertiary mt-2 px-1 text-xs">
                  Deleted, but the branch was kept because its work is not on the trunk. Phosphor
                  never force-deletes commits.
                </p>
              )}
            </div>

            <div className="border-border bg-bg-secondary flex items-center gap-2 border-t px-3 py-2">
              <span className="text-text-tertiary text-xs">
                {running ? `${done} of ${total} done` : `${results.length} processed`}
              </span>
              <span className="flex-1" />
              {running && (
                <button
                  type="button"
                  onClick={() => useSessionsStore.getState().cancelBulkDelete()}
                  disabled={cancelled}
                  className="border-border text-text-secondary hover:text-text rounded-md border px-2.5 py-1 text-xs disabled:opacity-40"
                >
                  {cancelled ? 'Stopping…' : 'Stop'}
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>,
    document.body,
  )
}

function summaryTitle(processed: number, failed: number, cancelled: boolean): string {
  if (failed > 0) return `${processed - failed} deleted, ${failed} kept`
  if (cancelled) return `Stopped after ${processed}`
  return `Deleted ${processed} lane${processed === 1 ? '' : 's'}`
}
