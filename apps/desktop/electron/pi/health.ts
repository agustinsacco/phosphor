import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isPiTooOld, MIN_PI_VERSION, type PiHealth } from '@shared/models'
import { extractVersion } from '@phosphor/session-runtime/pi/versions'
import { piProcessEnv } from '@phosphor/session-runtime/pi/shell-env'
import { resolveBinary } from './binary-lookup'
import { createTtlCache } from './ttl-cache'

const execFileAsync = promisify(execFile)

/**
 * Locate the pi binary and gate on MIN_PI_VERSION.
 *
 * Runs pi with the login shell's PATH: pi is a `#!/usr/bin/env node` script,
 * so under a version manager (fnm/nvm/asdf/volta) it needs node on PATH to
 * start at all — a GUI-inherited PATH isn't enough.
 */
export async function checkPiHealth(): Promise<PiHealth> {
  // The login-shell PATH first: the version-manager-aware case, and what pi
  // is also spawned with.
  const binaryPath = await resolveBinary('pi')
  if (!binaryPath) {
    return {
      ok: false,
      minVersion: MIN_PI_VERSION,
      reason: 'not-found',
      message:
        'The pi coding agent was not found on your PATH. Install it with: ' +
        'npm install -g @earendil-works/pi-coding-agent',
    }
  }
  const launch = { binaryPath }

  const env = await piProcessEnv()
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'], {
      timeout: 15_000,
      env,
    })
    // pi prints the version on stdout; some setups emit warnings on stderr.
    const version = extractVersion(stdout) ?? extractVersion(stderr)
    if (!version) {
      return {
        ok: false,
        ...launch,
        minVersion: MIN_PI_VERSION,
        reason: 'version-check-failed',
        message: versionFailureMessage(binaryPath, stdout, stderr),
      }
    }
    if (isPiTooOld(version)) {
      return {
        ok: false,
        ...launch,
        version,
        minVersion: MIN_PI_VERSION,
        reason: 'too-old',
        message: `pi ${version} is older than the minimum supported ${MIN_PI_VERSION}. Update with: npm install -g @earendil-works/pi-coding-agent@latest`,
      }
    }
    return { ok: true, ...launch, version, minVersion: MIN_PI_VERSION }
  } catch (error) {
    // execFile rejects on non-zero exit; its stderr holds the real reason
    // (classically "env: node: No such file or directory").
    const failure = error as { stderr?: string; stdout?: string; message: string }
    return {
      ok: false,
      ...launch,
      minVersion: MIN_PI_VERSION,
      reason: 'version-check-failed',
      message: versionFailureMessage(
        binaryPath,
        failure.stdout ?? '',
        failure.stderr || failure.message,
      ),
    }
  }
}

/** Explain the failure, calling out the common version-manager case. */
function versionFailureMessage(binaryPath: string, stdout: string, stderr: string): string {
  const detail = (stderr || stdout).trim().split('\n')[0]?.trim() ?? ''
  if (/env:\s*node|node:.*not found|command not found/i.test(detail)) {
    return (
      `Found pi at ${binaryPath}, but Node.js could not be located to run it (${detail}). ` +
      'This usually means a version manager (fnm, nvm, asdf, volta) sets up Node in your shell ' +
      'rc file in a way that GUI apps do not inherit. Launching Phosphor from a terminal, or ' +
      'installing Node system-wide, resolves it.'
    )
  }
  return detail
    ? `pi --version failed at ${binaryPath}: ${detail}`
    : `pi --version produced no output at ${binaryPath}.`
}

/** How long a healthy pi stays believed without re-running `pi --version`. */
const HEALTH_TTL_MS = 5 * 60_000

/**
 * A healthy answer, cached; an unhealthy one always re-checked.
 *
 * Only success is worth caching. A user who installs pi while the setup screen
 * is up must see it work on the next check, not five minutes later — so the
 * loader throws on `!ok`, which `createTtlCache` deliberately does not store.
 */
const healthCache = createTtlCache(async () => {
  const health = await checkPiHealth()
  if (!health.ok) throw health
  return health
}, HEALTH_TTL_MS)

export async function cachedPiHealth(): Promise<PiHealth> {
  try {
    return await healthCache.get()
  } catch (rejected) {
    // The loader rejects WITH the unhealthy result, so there is nothing to
    // re-run: hand it straight back.
    if (rejected && typeof rejected === 'object' && 'ok' in rejected) return rejected as PiHealth
    throw rejected
  }
}

export function invalidatePiHealth(): void {
  healthCache.invalidate()
}
