import { useState } from 'react'
import type { AccountView } from '@shared/account'
import { ipcErrorText } from '@shared/errors'
import { Button } from '@/components/form'
import { CheckIcon, Spinner } from '@/components/icons'
import { useAccount } from '../useAccount'

/**
 * Optional sign-in to Phosphor itself, with GitHub. Only while Settings →
 * Advanced → Phosphor account (preview) is on. Local work never needs it;
 * main owns the session (`electron/account/`) and this sees no token.
 */
export function PhosphorAccountSection(): React.JSX.Element | null {
  const [view, setView] = useAccount()
  const [error, setError] = useState<string | null>(null)
  if (!view?.preview) return null
  const { account } = view

  const run = async (action: () => Promise<AccountView | void>): Promise<void> => {
    setError(null)
    try {
      const next = await action()
      if (next) setView(next)
    } catch (caught) {
      setError(ipcErrorText(caught))
    }
  }
  const signIn = (): Promise<void> => run(() => window.phosphor.invoke('account:signIn'))
  const failure = error ?? (account.status === 'signed-out' ? account.error : undefined)

  return (
    <section className="mt-5">
      <h3 className="text-text-secondary text-sm font-medium tracking-wide uppercase">
        Phosphor account
      </h3>
      <div className="border-border mt-2 rounded-lg border px-3.5 py-3">
        {account.status === 'signed-in' ? (
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-base font-medium">
                  {account.user.login
                    ? `@${account.user.login}`
                    : (account.user.name ?? 'Signed in')}
                </span>
                <span className="bg-success/15 text-success inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-sm">
                  <CheckIcon size={11} />
                  Signed in
                </span>
              </div>
              {account.user.email && (
                <p className="text-text-secondary mt-0.5 truncate text-sm">{account.user.email}</p>
              )}
              {!account.remembered && (
                <p className="text-text-tertiary mt-1 text-sm">
                  Until Phosphor quits: {account.storageNote ?? 'it could not be saved'}.
                </p>
              )}
            </div>
            <Button
              variant="secondary"
              onClick={() => void run(() => window.phosphor.invoke('account:signOut'))}
            >
              Sign out
            </Button>
          </div>
        ) : account.status === 'signing-in' ? (
          <div className="flex items-center justify-between gap-4">
            <div className="text-text-secondary flex items-center gap-2 text-sm">
              <Spinner />
              Waiting for you to finish in your browser.
            </div>
            <button
              onClick={() => void run(() => window.phosphor.invoke('account:cancelSignIn'))}
              className="text-text-secondary hover:text-text text-base"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <p className="text-text-secondary text-sm">
              Optional. Signing in will let you see and control your machines from other devices.
              Everything on this computer works without it.
            </p>
            <Button variant="secondary" onClick={() => void signIn()}>
              Sign in with GitHub
            </Button>
          </div>
        )}
      </div>
      {failure && <p className="text-danger mt-2 text-sm">{failure}</p>}
    </section>
  )
}
