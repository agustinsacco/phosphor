import {
  MIN_CLAUDE_CONTEXT_VERSION,
  type ClaudeUsageSnapshotResult,
  type PiPackageEntry,
} from '@phosphor/shared/models'
import { parseUsageOutput } from '@phosphor/shared/claude-usage'
import { claudeContextProviderShortfall } from '@phosphor/session-runtime/pi/provider-detect'
import { extractVersion } from '@phosphor/session-runtime/pi/versions'
import type { MachineClaude } from '@phosphor/shared/host-protocol-machine'
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
 * Whether `claude` is logged in, by `claude auth status`, or why that could
 * not be read. stdout can hold the account's email, so a failure is described
 * from stderr alone.
 */
export async function claudeLoggedIn(
  claude: string,
  environment: ProbeEnvironment,
  options: { timeoutMs?: number } = {},
): Promise<{ loggedIn: boolean } | { unreadable: string }> {
  const run = { ...environment, timeoutMs: options.timeoutMs ?? 10_000 }
  const auth = await probe(claude, ['auth', 'status'], run)
  const loggedIn = parseLoggedIn(auth.stdout)
  if (loggedIn === null) return { unreadable: probeFailure({ ...auth, stdout: '' }) }
  return { loggedIn }
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
      reason: 'Claude Code is not installed: run phosphor setup',
    }
  }
  const run = { ...environment, timeoutMs: options.timeoutMs ?? 10_000 }
  const versionRun = await probe(claude, ['--version'], run)
  const version = versionRun.code === 0 ? extractVersion(versionRun.stdout) : null
  if (!version) {
    return { available: false, reason: `${claude} --version failed${probeFailure(versionRun)}` }
  }
  const auth = await claudeLoggedIn(claude, environment, options)
  if ('unreadable' in auth) {
    return { available: false, reason: `${claude} auth status was unreadable${auth.unreadable}` }
  }
  if (!auth.loggedIn) {
    return {
      available: false,
      reason: 'claude is not logged in: phosphor providers login claude',
    }
  }
  return { available: true, claude, version }
}

/** Independent diagnostics: a missing provider must not hide a missing CLI or login. */
export async function inspectClaude(
  packages: Pick<PiPackageEntry, 'name' | 'version' | 'installed'>[],
  environment: ProbeEnvironment,
): Promise<MachineClaude> {
  const installed = packages.some((pkg) => pkg.name === CLAUDE_PROVIDER_PACKAGE && pkg.installed)
  const provider =
    claudeContextProviderShortfall(packages) === null ? 'ok' : installed ? 'outdated' : 'missing'
  const claude = await which('claude', environment.env.PATH ?? '')
  if (!claude) return { provider, cli: 'missing', auth: 'unknown' }
  const auth = await claudeLoggedIn(claude, environment, { timeoutMs: 2000 })
  return {
    provider,
    cli: 'ok',
    auth: 'loggedIn' in auth ? (auth.loggedIn ? 'ok' : 'signed-out') : 'unknown',
  }
}

/** Reuse window for one `/usage` answer; the upstream endpoint rate-limits. */
const USAGE_TTL_MS = 60_000
/** A client's refresh still cannot run the CLI more often than this. */
const USAGE_FORCE_FLOOR_MS = 10_000

export type ClaudeUsageRead = (
  environment: ProbeEnvironment,
  options?: { force?: boolean; nowMs?: number },
) => Promise<ClaudeUsageSnapshotResult>

/**
 * The Host's own plan usage, from `claude -p /usage` under pi's environment:
 * zero model calls and zero quota. Parsed here so reset stamps use this
 * machine's timezone; the free-text "contributing" block is dropped, so only
 * labels, percentages and reset times leave the Host. Failures are not cached.
 */
export function claudeUsageReader(run: typeof probe = probe): ClaudeUsageRead {
  let cached: { at: number; result: ClaudeUsageSnapshotResult } | null = null
  return async (environment, options = {}) => {
    const now = options.nowMs ?? Date.now()
    const age = cached ? now - cached.at : Infinity
    if (cached && age < (options.force ? USAGE_FORCE_FLOOR_MS : USAGE_TTL_MS)) return cached.result
    const claude = await which('claude', environment.env.PATH ?? '')
    if (!claude) return { ok: false, error: 'claude-not-found' }
    const out = await run(
      claude,
      ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
      { ...environment, timeoutMs: 20_000 },
    )
    if (out.code !== 0 || out.truncated) return { ok: false, error: 'run-failed' }
    const snapshot = parseUsageOutput(out.stdout, now)
    if (!snapshot) return { ok: false, error: 'no-usage' }
    const result: ClaudeUsageSnapshotResult = {
      ok: true,
      snapshot: { ...snapshot, contributing: null },
    }
    cached = { at: now, result }
    return result
  }
}
