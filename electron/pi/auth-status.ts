import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SubscriptionProvider, SubscriptionProviderStatus } from '@shared/models'
import { accountFromCredential, credentialFingerprint } from './auth-identity'
import { checkPiHealth } from './health'
import { piProcessEnv } from './shell-env'

const execFileAsync = promisify(execFile)

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
 * One readiness check, asked in the one way both call sites must ask it.
 *
 * `--credentials` is what makes the account email knowable — pi has no other
 * command that says whose account a provider holds. It puts the token on
 * stdout, so it is read once by `parseAuthCheck` and never stored, returned or
 * logged; the argv itself carries no secret.
 */
const AUTH_CHECK_ARGS = (providerId: string): string[] => [
  'auth',
  'check',
  '--provider',
  providerId,
  '--json',
  '--no-refresh',
  '--credentials',
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

/**
 * Ask pi whether one provider is signed in.
 *
 * Split out so the login flow can poll a single provider for completion:
 * pi's TUI announces success in prose, but `auth check` is the fact.
 *
 * The fingerprint comes back with it, because "signed in" alone does not
 * answer the question a *re-*sign-in asks: a provider that was already signed
 * in reports `ready` from its old credential the moment you ask.
 */
export async function checkProviderAuth(providerId: string): Promise<AuthCheck> {
  const health = await checkPiHealth()
  if (!health.ok || !health.binaryPath) return { status: 'unknown' }
  const env = await piProcessEnv()
  try {
    const { stdout } = await execFileAsync(health.binaryPath, AUTH_CHECK_ARGS(providerId), {
      env,
      timeout: 10_000,
      encoding: 'utf8',
    })
    return parseAuthCheck(stdout)
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout
    if (typeof stdout === 'string' && stdout.includes('{')) return parseAuthCheck(stdout)
    return { status: 'unknown' }
  }
}

/**
 * What the renderer is allowed to see of an `auth check`.
 *
 * The fingerprint is a main-process comparison value with no meaning in the
 * UI, and it is derived from a credential — so it stops here rather than
 * riding a spread across IPC.
 */
function forRenderer(check: AuthCheck): Omit<AuthCheck, 'fingerprint'> {
  const { fingerprint: _fingerprint, ...rest } = check
  return rest
}

/**
 * Ask pi whether each subscription provider is signed in.
 *
 * `--no-refresh` on purpose: refreshing an expired OAuth token is a network
 * round trip per provider, and this runs on every settings open. A token that
 * needs refreshing still reports `ready` — pi refreshes it when a session
 * actually uses it.
 */
export async function checkSubscriptionAuth(): Promise<SubscriptionProviderStatus[]> {
  const health = await checkPiHealth()
  if (!health.ok || !health.binaryPath) {
    const error = health.message ?? 'pi is not available'
    return SUBSCRIPTION_PROVIDERS.map((p) => ({ ...p, status: 'unknown' as const, error }))
  }

  // pi is a `#!/usr/bin/env node` script — it needs the login shell's PATH to
  // find node under a version manager (see shell-env.ts).
  const env = await piProcessEnv()
  const binaryPath = health.binaryPath

  return Promise.all(
    SUBSCRIPTION_PROVIDERS.map(async (provider) => {
      try {
        const { stdout } = await execFileAsync(binaryPath, AUTH_CHECK_ARGS(provider.id), {
          env,
          timeout: 10_000,
          encoding: 'utf8',
        })
        return { ...provider, ...forRenderer(parseAuthCheck(stdout)) }
      } catch (error) {
        // `pi auth check` exits 0 even for not_ready, so a throw here means the
        // spawn or the timeout failed — never "the user is signed out".
        const stdout = (error as { stdout?: string }).stdout
        if (typeof stdout === 'string' && stdout.includes('{')) {
          return { ...provider, ...forRenderer(parseAuthCheck(stdout)) }
        }
        return {
          ...provider,
          status: 'unknown' as const,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  )
}
