import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { ModalOverlay } from '@/components/Modal'
import { CloseIcon } from '@/components/icons'
import { Button, TextInput } from '@/components/form'
import {
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_FIELD_MAX,
  isFeedbackSubmittable,
  type FeedbackDraft,
  type FeedbackRating,
} from '@shared/feedback'
import { useFeedbackStore } from './feedbackStore'

/**
 * The feedback form.
 *
 * Opens only when the user asks for it — the sidebar button, the command
 * palette, or the one-time nudge. Nothing here is sent until Submit, and the
 * form says plainly which of the two paths it is about to take, because only
 * one of them can actually be anonymous.
 */

const RATING_LABELS: Record<FeedbackRating, string> = {
  1: 'Frustrating',
  2: 'Rough',
  3: 'Fine',
  4: 'Good',
  5: 'Love it',
}

const EMPTY: FeedbackDraft = {
  rating: 4,
  comment: '',
  wishlist: '',
  anonymous: true,
  contact: '',
  includeEnvironment: true,
}

function StarPicker({
  rating,
  onChange,
}: {
  rating: FeedbackRating
  onChange: (rating: FeedbackRating) => void
}): React.JSX.Element {
  const [hover, setHover] = useState<FeedbackRating | null>(null)
  const shown = hover ?? rating
  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-1" onMouseLeave={() => setHover(null)}>
        {([1, 2, 3, 4, 5] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-label={`${value} of 5`}
            aria-pressed={rating === value}
            onMouseEnter={() => setHover(value)}
            onClick={() => onChange(value)}
            className={clsx(
              'text-2xl leading-none transition-colors',
              value <= shown ? 'text-accent' : 'text-border-strong hover:text-text-tertiary',
            )}
          >
            ★
          </button>
        ))}
      </div>
      <span className="text-text-secondary text-base">{RATING_LABELS[shown]}</span>
    </div>
  )
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  placeholder: string
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="text-base font-medium">{label}</span>
      {hint && <span className="text-text-tertiary ml-2 text-sm">{hint}</span>}
      <textarea
        value={value}
        maxLength={FEEDBACK_FIELD_MAX}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="border-border bg-surface text-text placeholder:text-text-tertiary mt-1.5 h-24 w-full resize-none rounded-md border px-2.5 py-2 text-base outline-none focus:border-[var(--px-border-strong)]"
      />
    </label>
  )
}

export function FeedbackModal(): React.JSX.Element | null {
  const open = useFeedbackStore((s) => s.open)
  const state = useFeedbackStore((s) => s.state)
  const sent = useFeedbackStore((s) => s.sent)
  const submitting = useFeedbackStore((s) => s.submitting)
  const [draft, setDraft] = useState<FeedbackDraft>(EMPTY)

  // A fresh form every time it opens: feedback is a one-shot, and a stale
  // half-written draft from three weeks ago is worse than an empty box. The
  // refresh is what tells the form which of the two submit paths is live —
  // the palette can open this without the sidebar button having run.
  useEffect(() => {
    if (!open) return
    setDraft(EMPTY)
    void useFeedbackStore.getState().refresh()
  }, [open])

  if (!open) return null
  const close = (): void => useFeedbackStore.getState().setOpen(false)

  // Only a relay posts under its own identity. In browser mode the issue is
  // created by the user's own GitHub account, so offering an anonymity switch
  // would be a promise the app cannot keep.
  const canBeAnonymous = state?.mode === 'relay'
  const anonymous = canBeAnonymous && draft.anonymous
  const patch = (over: Partial<FeedbackDraft>): void => setDraft({ ...draft, ...over })

  return (
    <ModalOverlay onClose={close}>
      <div className="border-border bg-bg flex max-h-[86vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-2xl border shadow-2xl">
        <header className="border-border flex items-start justify-between gap-4 border-b px-5 py-4">
          <div>
            <h2 className="text-xl font-semibold">How is Phosphor going?</h2>
            <p className="text-text-tertiary mt-0.5 text-sm">
              Honest answers are the useful ones. This goes to a public issue in{' '}
              {state?.repo ?? 'the Phosphor repo'}.
            </p>
          </div>
          <button
            onClick={close}
            aria-label="Close"
            className="text-text-tertiary hover:text-text -mr-1 rounded p-1"
          >
            <CloseIcon />
          </button>
        </header>

        {sent?.ok ? (
          <div className="flex flex-col gap-3 px-5 py-8 text-center">
            <div className="text-lg font-medium">Thank you.</div>
            <p className="text-text-secondary text-base">
              {sent.mode === 'github'
                ? 'GitHub is open in your browser with the issue filled in — press Submit there to post it.'
                : 'Your feedback has been filed.'}
            </p>
            <div className="mt-2 flex justify-center gap-2">
              {sent.url && (
                <Button onClick={() => void window.phosphor.invoke('app:openExternal', sent.url!)}>
                  Open the issue
                </Button>
              )}
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
            <div>
              <div className="mb-2 text-base font-medium">Your rating</div>
              <StarPicker rating={draft.rating} onChange={(rating) => patch({ rating })} />
            </div>

            <Field
              label="What's working, what isn't"
              value={draft.comment}
              onChange={(comment) => patch({ comment })}
              placeholder="The good and the bad. Specifics help more than politeness."
            />
            <Field
              label="Features you'd like to see"
              value={draft.wishlist}
              onChange={(wishlist) => patch({ wishlist })}
              placeholder="What would make Phosphor better for you?"
            />

            <div className="border-border flex flex-col gap-2 border-t pt-3">
              <label className="flex items-start gap-2 text-base">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={anonymous}
                  disabled={!canBeAnonymous}
                  onChange={(e) => patch({ anonymous: e.target.checked })}
                />
                <span className={clsx(!canBeAnonymous && 'text-text-tertiary')}>
                  Send anonymously
                  <span className="text-text-tertiary ml-2 text-sm">
                    {canBeAnonymous
                      ? 'No name, no contact details.'
                      : 'Unavailable: the issue is opened in your browser, under your own GitHub account.'}
                  </span>
                </span>
              </label>

              {!anonymous && (
                <TextInput
                  value={draft.contact ?? ''}
                  maxLength={FEEDBACK_CONTACT_MAX}
                  placeholder="Optional: how to reach you for follow-up"
                  onChange={(e) => patch({ contact: e.target.value })}
                  className="w-full"
                />
              )}

              <label className="flex items-start gap-2 text-base">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={draft.includeEnvironment}
                  onChange={(e) => patch({ includeEnvironment: e.target.checked })}
                />
                <span>
                  Include app version and platform
                  <span className="text-text-tertiary ml-2 text-sm">
                    Nothing else about your machine, your code or your sessions is ever attached.
                  </span>
                </span>
              </label>
            </div>
          </div>
        )}

        {!sent?.ok && (
          <footer className="border-border flex items-center justify-between gap-3 border-t px-5 py-3">
            <span className="text-danger min-w-0 truncate text-sm">
              {sent && !sent.ok ? sent.error : ''}
            </span>
            <div className="flex shrink-0 gap-2">
              <Button onClick={close}>Cancel</Button>
              <Button
                variant="primary"
                disabled={submitting || !isFeedbackSubmittable(draft)}
                onClick={() => void useFeedbackStore.getState().submit({ ...draft, anonymous })}
              >
                {submitting ? 'Sending…' : state?.mode === 'relay' ? 'Send' : 'Open on GitHub'}
              </Button>
            </div>
          </footer>
        )}
      </div>
    </ModalOverlay>
  )
}
