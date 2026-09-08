import { useState } from 'react'
import clsx from 'clsx'
import { ModalOverlay } from '@/components/Modal'
import { useSessionsStore } from '@/stores/sessions'
import { prChip } from './prChip'
import { describeWarnings, type PreflightSummary } from './deletePreflight'

/**
 * Confirm for deleting several lanes at once.
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
            Delete {count} lane{count === 1 ? '' : 's'}
            {summary.blocked.length > 0 && (
              <span className="text-danger font-normal"> · {summary.blocked.length} refused</span>
            )}
          </h2>
          <p className="text-text-secondary mt-1 text-sm">
            Removing a lane can touch three things. Only the first two are on by default.
          </p>
        </div>

        <div className="max-h-64 overflow-y-auto px-5 py-3">
          <div className="border-border divide-border divide-y overflow-hidden rounded-md border">
            {summary.lanes.map((lane) => (
              <div
                key={lane.path}
                className={clsx(
                  'flex items-center gap-2 px-3 py-2 text-sm',
                  lane.blocker && 'bg-danger-soft',
                )}
              >
                <span className="w-[18px] shrink-0 text-center">{lane.marker || '•'}</span>
                <span
                  className={clsx(
                    'min-w-0 flex-1 truncate',
                    lane.blocker && 'line-through opacity-75',
                  )}
                >
                  {lane.title}
                </span>
                {lane.blocker && <Badge tone="bad">turn in progress</Badge>}
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
              ? 'No selected lane runs in its own worktree.'
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
            Delete {count} lane{count === 1 ? '' : 's'}
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

/**
 * The progress and summary view for a bulk delete in flight.
 *
 * Separate from `BulkDeleteModal` because it is driven by store state rather
 * than by props: the run outlives the confirm dialog, and a delete of ten
 * lanes disposes ten subprocesses and runs git ten times. Without this the
 * sidebar simply froze for several seconds and rows vanished in one jump,
 * which reads as a crash rather than as work.
 *
 * The summary is not a toast. Per-lane outcomes matter here — a worktree that
 * would not remove because a terminal is cwd'd into it is the common case, and
 * that lane is still in the sidebar. A toast that says "3 deleted" while four
 * were selected is exactly the silent-failure this is meant to prevent.
 */
export function BulkDeleteProgressModal({
  onDone,
}: {
  onDone: () => void
}): React.JSX.Element | null {
  const progress = useSessionsStore((s) => s.bulkDelete)
  if (!progress) return null

  const { total, done, current, lanes, results, running, cancelled } = progress
  const failed = results.filter((r) => !r.ok)
  const warned = results.filter((r) => r.ok && r.error)
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  const byPath = new Map(results.map((result) => [result.path, result]))

  const close = (): void => {
    useSessionsStore.getState().dismissBulkDelete()
    onDone()
  }

  return (
    <ModalOverlay
      onClose={running ? () => undefined : close}
      closeOnBackdrop={!running}
      closeOnEscape={!running}
    >
      <div
        data-testid="bulk-delete-progress"
        className="bg-surface-raised border-border w-[min(34rem,94vw)] rounded-lg border shadow-2xl"
      >
        <div className="border-border border-b px-5 py-4">
          <h2 className="text-base font-semibold">
            {running
              ? cancelled
                ? 'Finishing the current lane…'
                : `Deleting ${done + 1} of ${total}`
              : summaryTitle(results.length, failed.length, cancelled)}
          </h2>
          <p className="text-text-secondary mt-1 truncate text-sm">
            {running ? current || 'Starting…' : 'Transcripts are in the Trash. Worktrees are gone.'}
          </p>
        </div>

        <div className="px-5 pb-1 pt-4">
          <div className="bg-chip h-1.5 w-full overflow-hidden rounded-full">
            <div
              className={clsx(
                'h-full rounded-full transition-[width] duration-200',
                failed.length > 0 ? 'bg-warning' : 'bg-accent',
              )}
              style={{ width: `${running ? Math.max(percent, 4) : 100}%` }}
            />
          </div>
        </div>

        {lanes.length > 0 && (
          <div className="max-h-56 overflow-y-auto px-5 py-3">
            <div className="border-border divide-border divide-y overflow-hidden rounded-md border">
              {lanes.map((lane) => {
                const result = byPath.get(lane.path)
                const active = running && !result && lane.title === current
                return (
                  <div
                    key={lane.path}
                    className={clsx(
                      'flex items-center gap-2 px-3 py-2 text-sm',
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
                          'max-w-[14rem] shrink-0 truncate text-2xs',
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
              <p className="text-text-tertiary mt-2 text-xs">
                Deleted, but the branch was kept: its work is not on the trunk yet, and Phosphor
                never force-deletes a branch that would lose commits.
              </p>
            )}
          </div>
        )}

        <div className="border-border bg-bg-secondary flex items-center gap-2 rounded-b-lg border-t px-5 py-3">
          <span className="text-text-tertiary text-xs">
            {running ? `${done} of ${total} done` : `${results.length} processed`}
          </span>
          <span className="flex-1" />
          {running ? (
            <button
              onClick={() => useSessionsStore.getState().cancelBulkDelete()}
              disabled={cancelled}
              className="border-border text-text-secondary hover:text-text rounded-md border px-3 py-1 text-sm disabled:opacity-40"
            >
              {cancelled ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button
              onClick={close}
              className="bg-accent text-accent-text rounded-md px-3 py-1 text-sm font-semibold"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}

function summaryTitle(processed: number, failed: number, cancelled: boolean): string {
  if (failed > 0) return `${processed - failed} deleted, ${failed} kept`
  if (cancelled) return `Stopped after ${processed}`
  return `Deleted ${processed} lane${processed === 1 ? '' : 's'}`
}
