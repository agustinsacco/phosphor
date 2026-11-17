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
}

/** One Tidy change: what it did, who did it, and Undo while it still applies. */
export function ChangeDetail({
  change,
  busy,
  message,
  onUndo,
}: {
  change: BrainTidyOperation
  busy: boolean
  /** Why the last Undo was refused, in the owner's words. */
  message: string
  onUndo: (operationId: string) => void
}): React.JSX.Element {
  return (
    <article aria-label="Change detail" className="space-y-3 p-4">
      <header>
        <h2 className="text-xl font-semibold">{change.summary}</h2>
        <p className="text-text-tertiary text-sm">
          {change.automatic ? 'Automatic' : 'By you'} · {relativeTime(change.createdAt)}
        </p>
      </header>
      <p>{CHANGE_WORDS[change.kind]}</p>
      {change.undoneAt ? (
        <p className="text-text-secondary">Undone {relativeTime(change.undoneAt)}.</p>
      ) : (
        <Button size="sm" disabled={busy} onClick={() => onUndo(change.id)}>
          Undo
        </Button>
      )}
      {message && (
        <p role="alert" className="text-danger text-sm">
          {message}
        </p>
      )}
    </article>
  )
}
