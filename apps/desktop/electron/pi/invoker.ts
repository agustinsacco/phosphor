import { cachedPiHealth } from './health'
import { piProcessEnv } from './shell-env'
import { piStubPath } from './stub'

/** Stub environments intentionally differ between sessions, titles and shell-aware jobs. */
export type PiInvocationProfile = 'minimal-stub' | 'inherited-stub' | 'piProcessEnv-stub'

export interface ResolvedPiInvoker {
  binaryPath: string
  prefixArgs: string[]
  env: Record<string, string>
  stub: boolean
}

/** Allows best-effort callers to distinguish unavailable pi from environment failures. */
export class PiUnavailableError extends Error {}

/** Only discovery is cached; each invocation gets its own current environment. */
export async function resolvePiInvoker(
  profile: PiInvocationProfile,
  options?: { stubPath?: string | null },
): Promise<ResolvedPiInvoker> {
  // An explicit override also lets callers disable the environment stub.
  const stub = options && 'stubPath' in options ? options.stubPath : piStubPath()
  if (stub) {
    const env =
      profile === 'minimal-stub'
        ? {}
        : profile === 'inherited-stub'
          ? ({ ...process.env } as Record<string, string>)
          : await piProcessEnv()
    return {
      binaryPath: process.execPath,
      prefixArgs: [stub],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stub: true,
    }
  }
  const health = await cachedPiHealth()
  if (!health.ok || !health.binaryPath) {
    throw new PiUnavailableError(health.message ?? 'pi is not available')
  }
  return {
    binaryPath: health.binaryPath,
    prefixArgs: [...(health.prefixArgs ?? [])],
    env: { ...(await piProcessEnv()) },
    stub: false,
  }
}
