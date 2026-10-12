import type { SubscriptionProvider } from '@phosphor/shared/models'
import { accountFromCredential, credentialFingerprint } from './auth-identity'

/**
 * Every provider pi offers under "Sign in with an account".
 *
 * Hand-curated, because pi offers no way to enumerate them: `/login` is
 * TUI-only, the RPC protocol has no auth command, and `@earendil-works/pi-ai`
 * stopped exporting its OAuth registry publicly — in 0.84 the `./oauth`
 * subpath is types-only, and the runtime moved from where 0.79 kept it.
 * Deep-importing that private path would break on a pi upgrade, so this list
 * is read off pi's own login screen instead (pi 0.84.1) and maintained by
 * hand. Every id here is verified to be accepted by `pi auth check
 * --provider`; an id pi does not know answers `provider_not_found`, which
 * surfaces as "unknown".
 *
 * Order is the order the Accounts tab renders: subscriptions first, because
 * using a plan you already pay for is the whole point of signing in here.
 */
export const SUBSCRIPTION_PROVIDERS: SubscriptionProvider[] = [
  {
    id: 'openai-codex',
    name: 'ChatGPT (Codex)',
    requires: 'ChatGPT Plus or Pro',
    billing: 'subscription',
    caveat:
      'Signing in through an OSS client is a supported path — OpenAI names pi specifically. Usage counts against your included ChatGPT usage.',
  },
  {
    id: 'anthropic',
    name: 'Claude Pro/Max',
    requires: 'Claude Pro or Max',
    billing: 'subscription',
    caveat:
      'Per pi’s own docs, third-party harness usage bills per token from extra usage — not against your Claude plan limits. For plan-limit usage, use the Claude Code provider extension instead.',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    requires: 'a Copilot subscription',
    billing: 'subscription',
    caveat:
      'Signs into github.com. For a GitHub Enterprise Server host, use “Open pi’s login terminal” instead — the host cannot be guessed.',
  },
  {
    id: 'kimi-for-coding',
    name: 'Kimi For Coding',
    requires: 'a Kimi For Coding plan',
    billing: 'subscription',
  },
  {
    id: 'xai',
    name: 'xAI',
    requires: 'an xAI account',
    billing: 'balance',
    caveat: 'Billed per token against your xAI credit balance, not a flat plan.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    requires: 'an OpenRouter account',
    billing: 'balance',
    caveat: 'Billed per token against your OpenRouter credit balance, not a flat plan.',
  },
  {
    id: 'radius',
    name: 'Radius',
    requires: 'a Radius account',
    billing: 'balance',
  },
]

/**
 * One readiness check, asked the one way every caller must ask it.
 *
 * `--no-refresh` keeps it local: refreshing an expired OAuth token is a network
 * round trip per provider, and a token that needs refreshing still reports
 * `ready` (pi refreshes it when a session uses it).
 *
 * `credentials` adds `--credentials`, which is what makes the account email
 * knowable: pi has no other command that says whose account a provider holds.
 * It puts the token on stdout, so it is read once by `parseAuthCheck` and never
 * stored, returned or logged; the argv itself carries no secret. A caller that
 * only needs ready or not leaves it off, and then no credential is printed.
 */
export const authCheckArgs = (providerId: string, options: { credentials: boolean }): string[] => [
  'auth',
  'check',
  '--provider',
  providerId,
  '--json',
  '--no-refresh',
  ...(options.credentials ? ['--credentials'] : []),
]

/**
 * Parse one `pi auth check --json` line.
 *
 * Pure and total: any shape we do not recognise becomes `unknown` rather than
 * throwing, because this runs for every provider on every settings open and a
 * malformed line must not take the tab down with it.
 *
 * This is also the only place a credential is ever looked at: `--credentials`
 * puts the token in that line, and the account email is read out of it here
 * (see `auth-identity.ts`) so the secret goes no further than this function.
 * Nothing it returns contains the credential.
 */
export function parseAuthCheck(stdout: string): {
  status: 'ready' | 'not_ready' | 'unknown'
  reason?: string
  /** Who the provider is signed in as, when the credential says. */
  account?: string
  /**
   * Which credential this is, as a process-local digest — never the credential
   * and never sent to the renderer (`checkSubscriptionAuth` drops it). The
   * sign-in flow compares it before and after to tell a new sign-in from the
   * one that was already stored; see `isNewCredential` in `login-flow.ts`.
   */
  fingerprint?: string
} {
  const line = stdout.trim().split('\n').at(-1)?.trim()
  if (!line || !line.startsWith('{')) return { status: 'unknown' }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { status: 'unknown' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { status: 'unknown' }
  const record = parsed as Record<string, unknown>
  const status = record.status
  const reason = typeof record.reason === 'string' ? record.reason : undefined
  const account = accountFromCredential(record.credentials)
  const fingerprint = credentialFingerprint(record.credentials)
  if (status === 'ready') {
    return {
      status: 'ready',
      ...(account ? { account } : {}),
      ...(fingerprint ? { fingerprint } : {}),
    }
  }
  if (status === 'not_ready') return { status: 'not_ready', reason }
  return { status: 'unknown', reason }
}

/** One `auth check`, as this process understands it. */
export type AuthCheck = ReturnType<typeof parseAuthCheck>
