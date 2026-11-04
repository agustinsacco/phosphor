import { useCallback, useEffect, useState } from 'react'
import type { LoginFlowState, SubscriptionProviderStatus } from '@shared/models'
import { errorText } from '@shared/errors'
import { readLocalSubscriptionAuth } from '@/stores/localSubscriptionAuth'
import type { ProviderAccountsSource } from './accountsModel'
import { useOnLocalRefresh } from '../../machine/ScopeRefresh'

/** Has this sign-in stopped, for better or worse? */
const isFlowEnded = (state: LoginFlowState): boolean =>
  state.phase === 'signed-in' || state.phase === 'cancelled' || state.phase === 'error'

/** pi's own login terminal: the escape hatch for a provider the in-app driver cannot answer. */
function useLoginTerminal(refresh: () => void, setError: (error: string | null) => void) {
  const [ptyId, setPtyId] = useState<string | null>(null)
  return {
    ptyId,
    open: () =>
      void window.phosphor.invoke('pi:loginTerminal', 80, 20).then(
        ({ ptyId: id }) => setPtyId(id),
        (caught: unknown) => setError(errorText(caught)),
      ),
    close: () => {
      if (ptyId) void window.phosphor.invoke('pty:kill', ptyId).catch(() => undefined)
      setPtyId(null)
      refresh()
    },
  }
}

/**
 * This Mac's providers. The sign-in is pi's TUI, driven off-screen by the main
 * process (`electron/pi/login-flow.ts`): a button per provider, the browser
 * opening, and the row flipping to "Signed in".
 */
export function useLocalProviders(): ProviderAccountsSource {
  const [providers, setProviders] = useState<SubscriptionProviderStatus[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [flow, setFlow] = useState<LoginFlowState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setProviders(await readLocalSubscriptionAuth())
      setLoadError(null)
    } catch (caught) {
      setLoadError(errorText(caught))
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useOnLocalRefresh(refresh)
  useEffect(
    () =>
      window.phosphor.onPiLoginState((state) => {
        const ended = isFlowEnded(state)
        // An ended flow clears the row, so a failed one does not hold every row busy.
        setFlow(ended ? null : state)
        if (state.phase === 'error') setError(state.message)
        // A cancelled or failed attempt can still have written credentials.
        if (ended) void refresh()
      }),
    [refresh],
  )
  const terminal = useLoginTerminal(() => void refresh(), setError)
  return {
    status: loadError
      ? { error: loadError, retry: () => void refresh() }
      : providers === null
        ? 'loading'
        : 'ready',
    caps: { signIn: 'in-app' },
    providers: providers ?? [],
    flow,
    error,
    busy: flow !== null,
    signIn: (id) => {
      const providerId = id as SubscriptionProviderStatus['id']
      setError(null)
      setFlow({ providerId, phase: 'starting' })
      void window.phosphor.invoke('pi:startLogin', providerId).catch((caught: unknown) => {
        setFlow(null)
        setError(errorText(caught))
      })
    },
    cancel: (id) => {
      void window.phosphor.invoke('pi:cancelLogin', id as SubscriptionProviderStatus['id'])
      setFlow(null)
    },
    terminal,
  }
}
