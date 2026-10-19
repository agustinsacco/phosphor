import { useState } from 'react'
import type { AccountView } from '@shared/account'
import { Button } from '@/components/form'
import { InstallApp } from './InstallApp'

/** Adapter-owned warnings survive a retry; only an account push can clear them. */
export function CompactSignIn({
  view,
  error,
}: {
  view: AccountView | null
  error: string | null
}): React.JSX.Element {
  const [actionError, setActionError] = useState('')
  const [signingOut, setSigningOut] = useState(false)
  const accountError = view?.account.status === 'signed-out' ? view.account.error : undefined
  const warning =
    accountError || (error ? 'Could not check sign-in. Check your connection and try again.' : '')
  return (
    <main className="compact-shell compact-sign-in">
      <h1>Phosphor</h1>
      <p>Your machines. Your lanes.</p>
      {!view && !error && <p role="status">Checking sign-in…</p>}
      <Button
        variant="primary"
        disabled={signingOut || view?.account.status === 'signing-in'}
        onClick={() => {
          setActionError('')
          void window.phosphor
            .invoke('account:signIn')
            .catch(() => setActionError('Could not start sign-in. Try again.'))
        }}
      >
        Sign in with GitHub
      </Button>
      {warning && <p role="alert">{warning}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {(warning || actionError) && (
        <Button
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true)
            setActionError('')
            void window.phosphor
              .invoke('account:signOut')
              .catch(() =>
                setActionError('Could not confirm sign-out or remote cleanup. Retry sign out.'),
              )
              .finally(() => setSigningOut(false))
          }}
        >
          {signingOut ? 'Signing out…' : 'Retry sign out'}
        </Button>
      )}
      <InstallApp />
      <p>On iPhone, sign in again from the Home Screen icon if you install the app.</p>
    </main>
  )
}
