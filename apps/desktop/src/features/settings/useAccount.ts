import { useEffect, useState } from 'react'
import type { AccountView } from '@shared/account'
import { ipcErrorText } from '@shared/errors'

/**
 * The Phosphor account as main reports it: read once, then kept current by
 * `account:changed`. Main pushes every change, so the push is the truth: an
 * action's own reply is not applied, since it can be older than a push from
 * another window. A push that lands before the first read wins over it too.
 */
export function useAccount(): { view: AccountView | null; error: string | null } {
  const [view, setView] = useState<AccountView | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let pushed = false
    let live = true
    const off = window.phosphor.onAccountChanged((next) => {
      pushed = true
      setView(next)
      setError(null)
    })
    window.phosphor.invoke('account:get').then(
      (next) => {
        if (live && !pushed) setView(next)
      },
      (caught: unknown) => {
        if (live && !pushed) setError(ipcErrorText(caught))
      },
    )
    return () => {
      live = false
      off()
    }
  }, [])
  return { view, error }
}
