import clsx from 'clsx'
import { SIGN_IN_LABEL } from './accountsModel'

const PILL = {
  ready: 'bg-success/15 text-success',
  not_ready: 'bg-warning/15 text-warning',
  unknown: 'bg-bg-secondary text-text-secondary',
} as const

/**
 * Signed in, not signed in, or could not verify: one word set for pi providers
 * and Claude accounts on every machine. "Could not verify" is never read as
 * signed out.
 */
export function SignInPill({
  state,
  reason,
}: {
  state: keyof typeof SIGN_IN_LABEL
  /** Why it could not be verified. */
  reason?: string
}): React.JSX.Element {
  return (
    <span
      data-sign-in={state}
      data-tooltip={reason}
      className={clsx('shrink-0 rounded-full px-2 py-0.5 text-sm font-normal', PILL[state])}
    >
      {SIGN_IN_LABEL[state]}
    </span>
  )
}
