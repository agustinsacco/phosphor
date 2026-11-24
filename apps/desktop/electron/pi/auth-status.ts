import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SubscriptionProviderStatus } from '@shared/models'
import { SUBSCRIPTION_PROVIDERS } from '@phosphor/shared/subscription-providers'
import {
  authCheckArgs,
  parseAuthCheck,
  type AuthCheck,
} from '@phosphor/session-runtime/pi/provider-auth'
import { checkPiHealth } from './health'
import { piProcessEnv } from '@phosphor/session-runtime/pi/shell-env'

const execFileAsync = promisify(execFile)

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
    const { stdout } = await execFileAsync(
      health.binaryPath,
      authCheckArgs(providerId, { credentials: true }),
      {
        env,
        timeout: 10_000,
        encoding: 'utf8',
      },
    )
    return parseAuthCheck(stdout)
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout
    if (typeof stdout === 'string' && stdout.includes('{')) return parseAuthCheck(stdout)
    return { status: 'unknown' }
  }
}

/**
 * Sign pi out of one provider. `pi auth logout` removes only what `/login`
 * stored and exits 0 when nothing was stored, so the re-check is the fact: a
 * provider that still answers ready has a key in the environment or
 * models.json, which sign-out cannot remove.
 */
export async function logoutProvider(providerId: string): Promise<void> {
  const provider = SUBSCRIPTION_PROVIDERS.find((entry) => entry.id === providerId)
  if (!provider) throw new Error('Unknown provider.')
  const health = await checkPiHealth()
  if (!health.ok || !health.binaryPath) throw new Error(health.message ?? 'pi is not available')
  await execFileAsync(health.binaryPath, ['auth', 'logout', provider.id], {
    env: await piProcessEnv(),
    timeout: 15_000,
    encoding: 'utf8',
  })
  if ((await checkProviderAuth(provider.id)).status === 'ready')
    throw new Error(
      `pi still finds a key for ${provider.name} in an environment variable or models.json. Remove it there to sign out.`,
    )
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
        const { stdout } = await execFileAsync(
          binaryPath,
          authCheckArgs(provider.id, { credentials: true }),
          {
            env,
            timeout: 10_000,
            encoding: 'utf8',
          },
        )
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
