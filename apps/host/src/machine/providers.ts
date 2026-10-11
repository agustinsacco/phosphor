import {
  SUBSCRIPTION_PROVIDERS,
  authCheckArgs,
  parseAuthCheck,
} from '@phosphor/session-runtime/pi/provider-auth'
import type { PiLaunch } from './executables'
import { probe, probeFailure, type ProbeEnvironment } from './probe'

/** The Claude lane's provider: checked as a lane, through `claude`, not here. */
const CLAUDE_CLI_PROVIDER = 'pi-claude-cli'

/** What a provider id from pi's settings may look like before it reaches an argv. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** One provider as this Host's pi sees it. Never a credential, never whose account. */
export interface ProviderState {
  /** pi's provider id, as `pi auth check --provider` and `/login` take it. */
  id: string
  name: string
  /** pi's own word, or `unknown` when the check could not run or answered nothing readable. */
  status: 'ready' | 'not_ready' | 'unknown'
  /** pi's reason (`credentials_not_configured`, `provider_not_found`), or why the check failed. */
  reason?: string
  /** pi's default provider: a session that names no model runs on it. */
  default?: true
}

/**
 * Ask this Host's pi, in pi's environment, which providers it can use: the
 * ones pi can sign into (Desktop's list), and pi's default provider when it is
 * another, such as an API key the config passes.
 *
 * `--credentials` is never passed, so pi prints a status and no credential,
 * and `--no-refresh` keeps every check off the network.
 */
export async function checkProviders(
  pi: Pick<PiLaunch, 'binaryPath' | 'prefixArgs'>,
  environment: ProbeEnvironment,
  options: { defaultProvider?: string; timeoutMs?: number } = {},
): Promise<ProviderState[]> {
  const listed = SUBSCRIPTION_PROVIDERS.map(({ id, name }) => ({ id: id as string, name }))
  const fallback = options.defaultProvider
  if (
    fallback &&
    fallback !== CLAUDE_CLI_PROVIDER &&
    PROVIDER_ID.test(fallback) &&
    !listed.some((provider) => provider.id === fallback)
  ) {
    listed.push({ id: fallback, name: fallback })
  }
  return Promise.all(
    listed.map(async ({ id, name }): Promise<ProviderState> => {
      const args = [...pi.prefixArgs, ...authCheckArgs(id, { credentials: false })]
      const run = await probe(pi.binaryPath, args, { ...environment, timeoutMs: options.timeoutMs })
      // pi exits 1 for not_ready and 2 for invalid, with its JSON on stdout either way.
      const { status, reason } = parseAuthCheck(run.stdout)
      const why =
        status === 'unknown' && !reason ? `pi auth check failed${probeFailure(run)}` : reason
      return {
        id,
        name,
        status,
        ...(why ? { reason: why } : {}),
        ...(id === fallback ? { default: true as const } : {}),
      }
    }),
  )
}

/** Words for pi's reasons; any other is shown as pi gave it. */
const REASONS: Record<string, string> = {
  credentials_not_configured: 'not signed in',
  credential_not_available: 'not signed in',
  provider_not_found: 'this pi does not offer it',
  invalid_state: 'pi could not read its models or credentials',
}

/** One provider's state, for a person. */
export function describeProvider(provider: ProviderState): string {
  if (provider.status === 'ready') return 'signed in'
  const reason = provider.reason ?? 'not signed in'
  return REASONS[reason] ?? reason
}
