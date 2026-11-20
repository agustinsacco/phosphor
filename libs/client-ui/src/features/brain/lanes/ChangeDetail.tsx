import type { BrainTidyOperation } from '@shared/brain-tidy'
import { Button } from '@/components/form'
import { relativeTime } from '@/lib/time'

const CHANGE_WORDS: Record<BrainTidyOperation['kind'], string> = {
  fold: 'Combined repeated memories and their evidence.',
  merge: 'Combined names, links and memories.',
  replace: 'One memory replaced the other.',
  dispute: 'Kept both memories as disputed.',
  split: 'Moved some memories to a new person or thing.',
  unname: 'Removed a shared name from one of them.',
  describe: 'Changed the description.',
  approve: 'Saved memories from a read.',
  reject: 'Rejected a read.',
  keep: 'Kept both sides as they are.',
  correct: 'Replaced a memory with a corrected one.',
  erase: 'Erased a memory.',
}
/** Who made a change, as the Recent changes list says it. */
export const CHANGE_WHO: Record<BrainTidyOperation['who'], string> = {
  you: 'By you',
  automatic: 'Automatic',
  agent: 'Brain Agent',
}

/** One Tidy change: what it did, who did it, and Undo while it still applies. */
export function changeTitle(change: BrainTidyOperation): string {
  return change.kind === 'erase'
    ? `Erased a memory${change.reason ? `: ${change.reason}` : ''}`
    : change.summary
}

export function ChangeDetail({
  change,
  busy,
  message,
  onUndo,
  onRead,
}: {
  change: BrainTidyOperation
  busy: boolean
  /** Why the last Undo was refused, in the owner's words. */
  message: string
  onUndo: (operationId: string) => void
  onRead: (jobId: string) => void
}): React.JSX.Element {
  return (
    <article aria-label="Change detail" className="space-y-3 p-4">
      <header>
        <h2 className="text-xl font-semibold">{changeTitle(change)}</h2>
        <p className="text-text-tertiary text-sm">
          {CHANGE_WHO[change.who]} · {relativeTime(change.createdAt)}
        </p>
      </header>
      <p>{change.kind === 'erase' ? 'Erasing can’t be undone.' : CHANGE_WORDS[change.kind]}</p>
      {change.reason && <p className="text-text-secondary">{change.reason}</p>}
      {change.jobId && (
        <Button size="sm" onClick={() => onRead(change.jobId!)}>
          See the read
        </Button>
      )}
      {change.undoneAt ? (
        <p className="text-text-secondary">Undone {relativeTime(change.undoneAt)}.</p>
      ) : change.undoable ? (
        <Button size="sm" disabled={busy} onClick={() => onUndo(change.id)}>
          Undo
        </Button>
      ) : null}
      {message && (
        <p role="alert" className="text-danger text-sm">
          {message}
        </p>
      )}
    </article>
  )
}
