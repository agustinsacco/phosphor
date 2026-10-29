import { useState } from 'react'
import { Button, Row, SectionTitle } from '@/components/form'
import { AccountAvatar } from '@/features/account/AccountFooter'
import { useAccount } from '../useAccount'

/** The Phosphor account this client is signed in with, and signing out of it. */
export function AccountTab(): React.JSX.Element {
  const { view, error: loadError } = useAccount()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const account = view?.account ?? { status: 'signed-out' as const }
  const user = account.status === 'signed-in' ? account.user : undefined
  const run = (channel: 'account:signIn' | 'account:signOut', failure: string): void => {
    setBusy(true)
    setError(null)
    void window.phosphor
      .invoke(channel)
      .catch(() => setError(failure))
      .finally(() => setBusy(false))
  }
  return (
    <div>
      <SectionTitle>Phosphor account</SectionTitle>
      {user ? (
        <Row
          title="Signed in"
          description={[user.name, user.login && `@${user.login}`, user.email]
            .filter(Boolean)
            .join(' · ')}
        >
          <div className="flex items-center gap-3">
            <AccountAvatar user={user} />
            <Button
              disabled={busy}
              onClick={() => run('account:signOut', 'Could not sign out. Try again.')}
            >
              {busy ? 'Signing out…' : 'Sign out'}
            </Button>
          </div>
        </Row>
      ) : (
        <Row
          title="Not signed in"
          description="Sign in with GitHub to reach the Hosts in your account."
        >
          <Button
            disabled={busy || account.status === 'signing-in'}
            onClick={() => run('account:signIn', 'Could not start sign-in. Try again.')}
          >
            {account.status === 'signing-in' ? 'Finish in your browser…' : 'Sign in with GitHub'}
          </Button>
        </Row>
      )}
      {(error ?? loadError) && (
        <p role="alert" className="text-danger mt-2 text-sm">
          {error ?? loadError}
        </p>
      )}
    </div>
  )
}
