import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import {
  AGENT_INSTALL_COMMANDS,
  MIN_PI_VERSION,
  type AgentKind,
  type PiHealth,
} from '@shared/models'
import { activeAgent } from './agent'
import { getLoginShellPath, piProcessEnv } from './shell-env'
import { createTtlCache, type TtlCache } from './ttl-cache'
import { log } from '../debug-log'
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

/** Pull a version like "0.78.0" (or omp's "omp/18.4.2") out of mixed CLI output. */
export function extractVersion(output: string): string | null {
  for (const line of output.split('\n')) {
    const match = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(line.trim())
    if (match) return match[1]!
  }
  return null
}

/**
 * Locate an agent's binary and check that it runs.
 *
 * Precedence: an explicit `binaryOverride` (Settings → Advanced → Agent)
 * wins outright and is never second-guessed by a PATH lookup — a path the
 * user typed that does not run is reported as such, not silently swapped for
 * whatever `command -v` finds. Without one, the login shell's PATH, then the
 * process PATH (`findOnPath`).
 *
 * Only pi is gated on a version floor. `MIN_PI_VERSION` is a number on pi's
 * release line; omp versions its own line (18.x), so comparing the two would
 * be meaningless — omp is only required to be runnable.
 *
 * Runs the agent with the login shell's PATH: pi is a `#!/usr/bin/env node`
 * script and omp a `#!/usr/bin/env bun` one, so under a version manager
 * (fnm/nvm/asdf/volta) each needs its interpreter on PATH to start at all — a
 * GUI-inherited PATH isn't enough.
 */
export async function checkAgentHealth(agent: AgentKind, binaryOverride = ''): Promise<PiHealth> {
  const minVersion = agent === 'pi' ? { minVersion: MIN_PI_VERSION } : {}
  const found: AgentLookup = binaryOverride
    ? { ok: true, launch: { file: binaryOverride, prefixArgs: [] } }
    : await findOnPath(agent)
  if (!found.ok) {
    return {
      ok: false,
      agent,
      ...minVersion,
      // A shim we cannot read through is "found but not runnable": the setup
      // screen's install command is still the right advice, but the message
      // must say where pi was seen, or the user reinstalls into the same spot.
      reason: found.failure.kind === 'not-found' ? 'not-found' : 'version-check-failed',
      message:
        agent === 'pi'
          ? describeWindowsLaunchFailure(found.failure)
          : `omp was not found on your PATH. Install it with: ${AGENT_INSTALL_COMMANDS.omp}, or set its path in Settings → Advanced → Agent.`,
    }
  }
  const { file: binaryPath, prefixArgs } = found.launch
  // Where the agent lives, for messages: the entry script on Windows, the binary elsewhere.
  const location = prefixArgs[0] ?? binaryPath
  // Only the Windows shape has a prefix; keep the POSIX result shape unchanged.
  const launch = prefixArgs.length > 0 ? { binaryPath, prefixArgs } : { binaryPath }

  const env = await piProcessEnv()
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, [...prefixArgs, '--version'], {
      timeout: 15_000,
      env,
    })
    // The version is on stdout; some setups emit warnings on stderr.
    const version = extractVersion(stdout) ?? extractVersion(stderr)
    if (!version) {
      return {
        ok: false,
        agent,
        ...launch,
        ...minVersion,
        reason: 'version-check-failed',
        message: versionFailureMessage(agent, location, stdout, stderr),
      }
    }
    if (agent === 'pi' && compareVersions(version, MIN_PI_VERSION) < 0) {
      return {
        ok: false,
        agent,
        ...launch,
        version,
        ...minVersion,
        reason: 'too-old',
        message: `pi ${version} is older than the minimum supported ${MIN_PI_VERSION}. Update with: npm install -g @earendil-works/pi-coding-agent@latest`,
      }
    }
    return { ok: true, agent, ...launch, version, ...minVersion }
  } catch (error) {
    // execFile rejects on non-zero exit; its stderr holds the real reason
    // (classically "env: node: No such file or directory").
    const failure = error as { stderr?: string; stdout?: string; message: string }
    return {
      ok: false,
      agent,
      ...launch,
      ...minVersion,
      reason: 'version-check-failed',
      message: versionFailureMessage(
        agent,
        location,
        failure.stdout ?? '',
        failure.stderr || failure.message,
      ),
    }
  }
}

/**
 * pi itself, whichever agent sessions run on.
 *
 * For the surfaces that drive pi's own CLI and packages rather than a
 * session — `pi auth`, the sign-in terminal, pi-mcp-adapter's connectors.
 * Those are pi features; running them through omp would ask omp for flags it
 * does not have.
 */
export function checkPiHealth(): Promise<PiHealth> {
  return checkAgentHealth('pi', activeAgent().binaryPaths.pi)
}

/** The agent new sessions spawn (Settings → Advanced → Agent). */
export function checkActiveAgentHealth(): Promise<PiHealth> {
  const { kind, binaryPaths } = activeAgent()
  return checkAgentHealth(kind, binaryPaths[kind])
}

/** The agent's arguments with the launch prefix a health result requires in front. */
export function piArgs(health: PiHealth, args: string[]): string[] {
  return [...(health.prefixArgs ?? []), ...args]
}

/** Explain the failure, calling out the common version-manager case. */
function versionFailureMessage(
  agent: AgentKind,
  binaryPath: string,
  stdout: string,
  stderr: string,
): string {
  const detail = (stderr || stdout).trim().split('\n')[0]?.trim() ?? ''
  const runtime = agent === 'pi' ? 'Node.js' : 'Bun'
  if (/env:\s*(node|bun)|(node|bun):.*not found|command not found/i.test(detail)) {
    return (
      `Found ${agent} at ${binaryPath}, but ${runtime} could not be located to run it (${detail}). ` +
      `This usually means a version manager (fnm, nvm, asdf, volta) sets up ${runtime} in your shell ` +
      'rc file in a way that GUI apps do not inherit. Launching Phosphor from a terminal, or ' +
      `installing ${runtime} system-wide, resolves it.`
    )
  }
  return detail
    ? `${agent} --version failed at ${binaryPath}: ${detail}`
    : `${agent} --version produced no output at ${binaryPath}.`
}

type AgentLookup =
  { ok: true; launch: WindowsLaunch } | { ok: false; failure: WindowsLaunchFailure }

async function findOnPath(agent: AgentKind): Promise<AgentLookup> {
  if (process.platform === 'win32') return probeWindows(agent)
  const file = await probePosix(agent)
  return file
    ? { ok: true, launch: { file, prefixArgs: [] } }
    : { ok: false, failure: { kind: 'not-found' } }
}

async function probePosix(agent: AgentKind): Promise<string | null> {
  // The names are fixed literals, never user input — safe inside `sh -c`.
  const lookup = `command -v ${agent}`
  // 1. Login-shell PATH (the version-manager-aware case, and what we will
  //    also hand to the agent when spawning it).
  const shellPath = await getLoginShellPath()
  if (shellPath) {
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', lookup], {
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
    const { stdout } = await execFileAsync('/bin/sh', ['-c', lookup], { timeout: 15_000 })
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
 *
 * omp is installed by bun, whose global bin holds a real `omp.exe`; that is
 * spawned directly, and anything else is left to the explicit binary setting.
 */
async function probeWindows(agent: AgentKind): Promise<AgentLookup> {
  const where = async (name: string): Promise<string> => {
    const { stdout } = await execFileAsync('where', [name], { timeout: 15_000 })
    return stdout
  }
  const stdout = await where(agent).catch(() => '')
  if (agent === 'omp') {
    const exe = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().endsWith('.exe'))
    return exe
      ? { ok: true, launch: { file: exe, prefixArgs: [] } }
      : { ok: false, failure: { kind: 'not-found' } }
  }
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

/** How long a healthy agent stays believed without re-running `--version`. */
const HEALTH_TTL_MS = 5 * 60_000

/**
 * One cache per agent choice (agent + explicit binary). Switching agents, or
 * pointing one at a new binary, must never answer with the other one's
 * health — including from a probe that was still running when the choice
 * changed, which a single cache's in-flight dedupe would hand to the new
 * caller. Each loader probes the choice it is keyed on, never whatever is
 * active by the time it runs.
 */
const healthCaches = new Map<string, TtlCache<PiHealth>>()

/**
 * A healthy answer, cached; an unhealthy one always re-checked.
 *
 * Only success is worth caching. A user who installs the agent while the
 * setup screen is up must see it work on the next check, not five minutes
 * later — so the loader throws on `!ok`, which `createTtlCache` deliberately
 * does not store.
 */
function healthCacheFor(agent: AgentKind, binaryOverride: string): TtlCache<PiHealth> {
  const key = `${agent}\0${binaryOverride}`
  let cache = healthCaches.get(key)
  if (!cache) {
    cache = createTtlCache(async () => {
      const health = await checkAgentHealth(agent, binaryOverride)
      // One line per fresh probe, beside the spawn argv this log already
      // records: on Windows this is the only place that shows WHICH node.exe
      // and entry script the launcher settled on (win-launch.ts), and it is
      // what the packaged-app smoke in CI asserts on.
      const { message: _message, ...facts } = health
      log('pi', 'health', facts)
      if (!health.ok) throw health
      return health
    }, HEALTH_TTL_MS)
    healthCaches.set(key, cache)
  }
  return cache
}

/** `checkActiveAgentHealth`, cached per agent choice. */
export async function cachedAgentHealth(): Promise<PiHealth> {
  const { kind, binaryPaths } = activeAgent()
  try {
    return await healthCacheFor(kind, binaryPaths[kind]).get()
  } catch (rejected) {
    // The loader rejects WITH the unhealthy result, so there is nothing to
    // re-run: hand it straight back.
    if (rejected && typeof rejected === 'object' && 'ok' in rejected) return rejected as PiHealth
    throw rejected
  }
}

export function invalidateAgentHealth(): void {
  for (const cache of healthCaches.values()) cache.invalidate()
}
