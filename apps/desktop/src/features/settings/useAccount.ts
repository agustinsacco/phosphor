import { useEffect, useState } from 'react'
import type { AccountView } from '@shared/account'

/**
 * The Phosphor account as main reports it: read once, then kept current by
 * `account:changed`. A push that lands before the first read wins over it.
 */
export function useAccount(): [AccountView | null, (view: AccountView) => void] {
  const [view, setView] = useState<AccountView | null>(null)
  useEffect(() => {
    let pushed = false
    let live = true
    const off = window.phosphor.onAccountChanged((next) => {
      pushed = true
      setView(next)
    })
    void window.phosphor.invoke('account:get').then((next) => {
      if (live && !pushed) setView(next)
    })
    return () => {
      live = false
      off()
    }
  }, [])
  return [view, setView]
}
