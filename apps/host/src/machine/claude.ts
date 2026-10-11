import { MIN_CLAUDE_CONTEXT_VERSION, type PiPackageEntry } from '@phosphor/shared/models'
import { claudeContextProviderShortfall } from '@phosphor/session-runtime/pi/provider-detect'
import { extractVersion } from '@phosphor/session-runtime/pi/versions'
import { which } from './executables'
import { probe, probeFailure, type ProbeEnvironment } from './probe'

export const CLAUDE_PROVIDER_PACKAGE = '@saccolabs/pi-claude-cli'

export type ClaudeLane =
  { available: true; claude: string; version: string } | { available: false; reason: string }

/**
 * `claude auth status` prints JSON on Claude Code 2.x, after any leading
 * noise, and still prints it with a non-zero exit when logged out. Only
 * `loggedIn` is read: the email and organization beside it identify a
 * person, and no report needs them.
 */
export function parseLoggedIn(stdout: string): boolean | null {
  const start = stdout.indexOf('{')
  if (start === -1) return null
  try {
    const loggedIn = (JSON.parse(stdout.slice(start)) as { loggedIn?: unknown }).loggedIn
    return typeof loggedIn === 'boolean' ? loggedIn : null
  } catch {
    return null
  }
}

/**
 * The Claude lane needs the provider package at the version Desktop
 * requires, then a `claude` on pi's PATH that is logged in. The package is
 * checked first: without it, the CLI's state does not matter.
 */
export async function checkClaudeLane(
  packages: Pick<PiPackageEntry, 'name' | 'version' | 'installed'>[],
  environment: ProbeEnvironment,
  options: { timeoutMs?: number } = {},
): Promise<ClaudeLane> {
  const shortfall = claudeContextProviderShortfall(packages)
  if (shortfall !== null) {
    return {
      available: false,
      reason:
        `${CLAUDE_PROVIDER_PACKAGE} ${MIN_CLAUDE_CONTEXT_VERSION} or newer is needed (${shortfall}): ` +
        `pi install npm:${CLAUDE_PROVIDER_PACKAGE}`,
    }
  }
  const claude = await which('claude', environment.env.PATH ?? '')
  if (!claude) {
    return {
      available: false,
      reason: "claude is not on pi's PATH: add its folder to /environment/path",
    }
  }
  const run = { ...environment, timeoutMs: options.timeoutMs ?? 10_000 }
  const versionRun = await probe(claude, ['--version'], run)
  const version = versionRun.code === 0 ? extractVersion(versionRun.stdout) : null
  if (!version) {
    return { available: false, reason: `${claude} --version failed${probeFailure(versionRun)}` }
  }
  const auth = await probe(claude, ['auth', 'status'], run)
  const loggedIn = parseLoggedIn(auth.stdout)
  if (loggedIn === null) {
    // stdout can hold the account's email: describe the failure from stderr alone.
    const failure = probeFailure({ ...auth, stdout: '' })
    return { available: false, reason: `${claude} auth status was unreadable${failure}` }
  }
  if (!loggedIn)
    return { available: false, reason: 'claude is not logged in: run claude auth login' }
  return { available: true, claude, version }
}
