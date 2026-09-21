import { useEffect } from 'react'
import clsx from 'clsx'
import { useFeedbackStore } from './feedbackStore'

/**
 * Sidebar footer entry to the feedback form, above Settings.
 *
 * Always a plain, quiet row — the feature has to be findable without ever
 * interrupting anyone. After enough real use it promotes itself once into a
 * question with a dot and a dismiss, and that is the entire nudge: no launch
 * popup, no toast, no second ask. Dismissing or sending retires it for good.
 */
export function FeedbackButton(): React.JSX.Element {
  const nudge = useFeedbackStore((s) => s.state?.nudge ?? false)

  useEffect(() => {
    void useFeedbackStore.getState().refresh()
  }, [])

  return (
    <div className="flex items-center">
      <button
        onClick={() => useFeedbackStore.getState().setOpen(true)}
        data-testid="feedback-button"
        data-nudge={nudge ? 'true' : 'false'}
        title="Rate Phosphor and tell us what to build next"
        className={clsx(
          '-mx-1 mb-1 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-base transition-colors',
          nudge
            ? 'text-text hover:bg-bg-secondary font-medium'
            : 'text-text-secondary hover:text-text hover:bg-bg-secondary',
        )}
      >
        {nudge ? (
          <span aria-hidden className="bg-accent h-1.5 w-1.5 shrink-0 rounded-full" />
        ) : (
          <span aria-hidden className="text-text-tertiary shrink-0 text-sm leading-none">
            ★
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">
          {nudge ? 'How is Phosphor going?' : 'Send feedback'}
        </span>
      </button>
      {nudge && (
        <button
          onClick={() => void useFeedbackStore.getState().dismissNudge()}
          aria-label="Dismiss"
          title="Don't ask again"
          className="text-text-tertiary hover:text-text mb-1 shrink-0 rounded px-1 text-sm"
        >
          ✕
        </button>
      )}
    </div>
  )
}
