import { handle } from './handle'
import { dismissFeedbackNudge, feedbackState, submitFeedback } from '../feedback/feedback-service'
import type { FeedbackDraft } from '@shared/feedback'

/**
 * App rating and feedback.
 *
 * `state` is read on every window open (it decides whether the quiet nudge
 * renders), so it stays a cheap prefs read with no network in it.
 */
export function registerFeedbackHandlers(): void {
  handle('feedback:state', () => feedbackState())

  handle('feedback:submit', (_event, draft: FeedbackDraft) => submitFeedback(draft))

  handle('feedback:dismiss', () => {
    dismissFeedbackNudge()
  })
}
