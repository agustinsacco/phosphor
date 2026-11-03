import clsx from 'clsx'
import { Spinner } from '@/components/icons'
import { Button } from './fields'

/**
 * A section's save state. `error`: the write failed and the change is kept to
 * try again. `refused`: the machine would not take it (a newer revision, a
 * rule), so it can only be discarded or edited.
 */
export interface SaveState {
  status: 'idle' | 'saving' | 'saved' | 'error' | 'refused'
  message?: string
  retry?: () => void
  discard?: () => void
}

const DEFAULT_TEXT: Record<SaveState['status'], string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved. Your change is kept until you try again or discard it.',
  refused: 'Not saved.',
}

/** One line for immediate saves and Host drafts alike; problems carry their own actions. */
export function SaveStatus({ state }: { state: SaveState }): React.JSX.Element | null {
  const { status, message, retry, discard } = state
  if (status === 'idle') return null
  const text = message ?? DEFAULT_TEXT[status]
  if (status === 'saving' || status === 'saved')
    return (
      <p
        role="status"
        data-save-status={status}
        className="text-text-tertiary flex min-h-5 items-center gap-2 text-sm"
      >
        {status === 'saving' && <Spinner className="text-text-tertiary" />}
        {text}
      </p>
    )
  return (
    <div
      role="alert"
      data-save-status={status}
      className={clsx(
        'space-y-2 rounded-lg border p-3',
        status === 'error' ? 'border-danger/30 bg-danger-soft' : 'border-warning/30 bg-warning/5',
      )}
    >
      <p
        className={clsx(
          'text-base font-medium',
          status === 'error' ? 'text-danger' : 'text-warning',
        )}
      >
        {text}
      </p>
      {(retry || discard) && (
        <div className="flex flex-wrap gap-2">
          {retry && (
            <Button size="sm" onClick={retry}>
              Try again
            </Button>
          )}
          {discard && (
            <Button size="sm" onClick={discard}>
              Discard changes
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
