import { useCallback, useEffect, useState } from 'react'
import type { LoginFlowState, SubscriptionProviderStatus } from '@shared/models'
import { errorText } from '@shared/errors'
import { readLocalSubscriptionAuth } from '@/stores/localSubscriptionAuth'
import { useModelCatalogueStore } from '@/stores/modelCatalogue'
import { promptChoice } from '@/stores/prompt'
import type { ProviderAccountsSource } from './accountsModel'
import { useLocalRead } from '../../machine/ScopeRefresh'

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

async function confirmSignOut(name: string): Promise<boolean> {
  const choice = await promptChoice({
    title: `Sign out of ${name}?`,
    message: `pi removes its saved sign-in for ${name} on this Mac. Lanes on its models stop working until you sign in again. A key in an environment variable or models.json stays.`,
    choices: [{ value: 'sign-out', label: 'Sign out', primary: true }],
  })
  return choice === 'sign-out'
}

/** `pi auth logout`, after a confirmation. The picker re-reads, so its models go. */
function useSignOut(
  providers: SubscriptionProviderStatus[] | null,
  refresh: () => Promise<void>,
  setError: (error: string | null) => void,
) {
  const [signingOut, setSigningOut] = useState(false)
  const signOut = async (id: SubscriptionProviderStatus['id']): Promise<void> => {
    const name = providers?.find((p) => p.id === id)?.name ?? id
    if (!(await confirmSignOut(name).catch(() => false))) return
    setError(null)
    setSigningOut(true)
    try {
      await window.phosphor.invoke('pi:logout', id)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setSigningOut(false)
    }
    // Even a refused sign-out may have removed the stored half.
    await refresh()
    const catalogue = useModelCatalogueStore.getState()
    if (catalogue.status !== 'idle') void catalogue.refresh()
  }
  return { signingOut, signOut }
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
  useLocalRead(refresh)
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
  const { signingOut, signOut } = useSignOut(providers, refresh, setError)
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
    busy: flow !== null || signingOut,
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
    signOut: (id) => void signOut(id as SubscriptionProviderStatus['id']),
    terminal,
  }
}
