import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { MIN_PI_VERSION, type PiHealth } from '@shared/models'
import { getLoginShellPath, piProcessEnv } from './shell-env'
import { createTtlCache } from './ttl-cache'
import {
  describeWindowsLaunchFailure,
  resolveWindowsLaunch,
  type WindowsLaunch,
  type WindowsLaunchFailure,
} from './win-launch'

const execFileAsync = promisify(execFile)

/** Compare dotted semver-ish strings. Returns <0, 0, >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Pull a version like "0.78.0" out of mixed CLI output. */
export function extractVersion(output: string): string | null {
  for (const line of output.split('\n')) {
    const match = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(line.trim())
    if (match) return match[1]!
  }
  return null
}

/**
 * Locate the pi binary and gate on MIN_PI_VERSION.
 *
 * Runs pi with the login shell's PATH: pi is a `#!/usr/bin/env node` script,
 * so under a version manager (fnm/nvm/asdf/volta) it needs node on PATH to
 * start at all — a GUI-inherited PATH isn't enough.
 */
export async function checkPiHealth(): Promise<PiHealth> {
  const found = await findPi()
  if (!found.ok) {
    return {
      ok: false,
      minVersion: MIN_PI_VERSION,
      // A shim we cannot read through is "found but not runnable": the setup
      // screen's install command is still the right advice, but the message
      // must say where pi was seen, or the user reinstalls into the same spot.
      reason: found.failure.kind === 'not-found' ? 'not-found' : 'version-check-failed',
      message: describeWindowsLaunchFailure(found.failure),
    }
  }
  const { file: binaryPath, prefixArgs } = found.launch
  // Where pi lives, for messages: the entry script on Windows, pi elsewhere.
  const location = prefixArgs[0] ?? binaryPath
  // Only the Windows shape has a prefix; keep the POSIX result shape unchanged.
  const launch = prefixArgs.length > 0 ? { binaryPath, prefixArgs } : { binaryPath }

  const env = await piProcessEnv()
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, [...prefixArgs, '--version'], {
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
        message: versionFailureMessage(location, stdout, stderr),
      }
    }
    if (compareVersions(version, MIN_PI_VERSION) < 0) {
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
        location,
        failure.stdout ?? '',
        failure.stderr || failure.message,
      ),
    }
  }
}

/** pi's arguments with the launch prefix a health result requires in front. */
export function piArgs(health: PiHealth, args: string[]): string[] {
  return [...(health.prefixArgs ?? []), ...args]
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

type PiLookup = { ok: true; launch: WindowsLaunch } | { ok: false; failure: WindowsLaunchFailure }

async function findPi(): Promise<PiLookup> {
  if (process.platform === 'win32') return probeWindows()
  const file = await probePosix()
  return file
    ? { ok: true, launch: { file, prefixArgs: [] } }
    : { ok: false, failure: { kind: 'not-found' } }
}

async function probePosix(): Promise<string | null> {
  // 1. Login-shell PATH (the version-manager-aware case, and what we will
  //    also hand to pi when spawning it).
  const shellPath = await getLoginShellPath()
  if (shellPath) {
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', 'command -v pi'], {
        timeout: 15_000,
        env: { ...process.env, PATH: shellPath },
      })
      const found = stdout.trim().split('\n').pop()?.trim()
      if (found) return found
    } catch {
      // fall through
    }
  }
  // 2. The process PATH (dev runs launched from a terminal).
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', 'command -v pi'], { timeout: 15_000 })
    const found = stdout.trim().split('\n').pop()?.trim()
    if (found) return found
  } catch {
    // fall through
  }
  return null
}

/**
 * Windows: `where pi` lists npm's three shims (sh script, `.cmd`, `.ps1`) and
 * none of them is spawnable — see `win-launch.ts` for why the `.cmd` is read
 * for its entry script and run through `node.exe` instead. A GUI process gets
 * the user's PATH here (no login shell to consult), which is where npm puts
 * `%APPDATA%\npm` — so a plain `npm install -g` is found. A version manager
 * that only amends PATH per terminal (fnm, nvm-windows without a system link)
 * is not, and the failure message says so.
 */
async function probeWindows(): Promise<PiLookup> {
  const where = async (name: string): Promise<string> => {
    const { stdout } = await execFileAsync('where', [name], { timeout: 15_000 })
    return stdout
  }
  const stdout = await where('pi').catch(() => '')
  return resolveWindowsLaunch(stdout, {
    readShim: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    whereNode: () => where('node'),
  })
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
