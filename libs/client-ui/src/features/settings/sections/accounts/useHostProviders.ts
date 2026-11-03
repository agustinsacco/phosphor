import type { MachineProvider } from '@shared/host-protocol-machine'
import { SUBSCRIPTION_PROVIDERS } from '@shared/subscription-providers'
import { useHostSection } from '../../machine/HostSection'
import type { ProviderAccountsSource, ProviderRow } from './accountsModel'

/** The Claude Code provider has its own page; Accounts lists pi's other providers. */
const CLAUDE_CODE_IDS = new Set(['claude', 'pi-claude-cli'])

/**
 * A Host's provider rows, joined to the shared catalogue for what each needs
 * and what it spends. A provider the catalogue does not list (pi's default,
 * configured with an API key) groups under Other providers. `keepClaude` keeps
 * the Claude Code rows for a view that has no Claude Code check of its own.
 */
export function providerRows(
  providers: readonly MachineProvider[],
  keepClaude = false,
): ProviderRow[] {
  return providers
    .filter((provider) => keepClaude || !CLAUDE_CODE_IDS.has(provider.id))
    .map(({ id, name, status }) => {
      const known = SUBSCRIPTION_PROVIDERS.find((entry) => entry.id === id)
      return { ...known, id, name, status }
    })
}

/**
 * A Host's providers. Sign-in runs pi's `/login` in a private terminal on the
 * Host; the Host never says whose account a provider holds.
 */
export function useHostProviders(): ProviderAccountsSource {
  const { settings, programs } = useHostSection()
  const state = settings.data?.providers
  return {
    status: state ? 'ready' : 'loading',
    caps: { signIn: 'terminal' },
    providers: providerRows(state?.providers ?? []),
    flow: null,
    error: null,
    busy: !programs.available || programs.busy || settings.saving || settings.loading,
    signIn: (id) => programs.login(id),
    cancel: undefined,
  }
}
