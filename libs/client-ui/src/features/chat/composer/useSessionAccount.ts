import { useEffect, useState } from 'react'
import type { ClaudeSessionAccount } from '@shared/models'
import { useSessionsStore } from '@/stores/sessions'

/**
 * Which Claude login this lane is spending.
 *
 * Decided once at spawn and answered by main from the parked pick, or from the
 * stored binding for a resumed lane. `ready` matters to the caller that has to
 * chain another request on the answer: null-and-not-ready is "still asking",
 * null-and-ready is "no account, ask for the default".
 */
export function useSessionClaudeAccount(
  sessionId: string,
  enabled = true,
): { account: ClaudeSessionAccount | null; ready: boolean } {
  const diskPath = useSessionsStore((s) => s.live[sessionId]?.diskPath)
  const [state, setState] = useState<{ account: ClaudeSessionAccount | null; ready: boolean }>({
    account: null,
    ready: false,
  })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void window.phosphor
      .invoke('claude:sessionAccount', sessionId, diskPath)
      // A rejected invoke (no handler, main restarted) is "no account", never
      // a permanent pending state — the caller has a request waiting on this.
      .catch((): ClaudeSessionAccount | null => null)
      .then((account) => {
        if (!cancelled) setState({ account, ready: true })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, diskPath, enabled])

  return state
}
