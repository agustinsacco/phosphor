import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { createClaudeUsage, runUsageCommand } from '@phosphor/session-runtime/claude/usage'
import { parseClaudeAuthStatus } from '@phosphor/session-runtime/claude/auth-status'
import { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import type { ClaudeStatus } from '@phosphor/shared/models'
import { which } from '../machine/executables'
import { probe } from '../machine/probe'

export const ACCOUNT_USAGE_TIMEOUT_MS = 12_000
const PROBE_PREFIX = 'phosphor-usage-'
/** `mkdtemp` adds six characters; nothing else in the temp dir is this code's. */
const PROBE_DIRECTORY = /^phosphor-usage-[A-Za-z0-9]{6}$/
/** Well past a probe's 20 s timeout, so a live probe of another Host is never swept. */
const SWEEP_AGE_MS = 5 * 60_000
const live = new Map<string, AbortController>()

async function usageProbe(file: string, env: NodeJS.ProcessEnv) {
  // Never use HOME or the lane workspace as a Claude project, even for the default login.
  const cwd = await mkdtemp(join(tmpdir(), PROBE_PREFIX))
  const abort = new AbortController()
  live.set(cwd, abort)
  try {
    return await runUsageCommand(
      (path, args, options) =>
        runPrintMode(path, args, { ...options, timeoutMs: ACCOUNT_USAGE_TIMEOUT_MS }),
      file,
      env,
      cwd,
      abort.signal,
    )
  } finally {
    live.delete(cwd)
    await rm(cwd, { recursive: true, force: true })
  }
}

/** Kill every pending usage probe and remove its directory now: the Host exits next. */
export function stopUsageProbes(): void {
  for (const [cwd, abort] of live) {
    abort.abort()
    rmSync(cwd, { recursive: true, force: true })
  }
}

/** At Host start: remove probe directories a killed Host left behind, by exact name only. */
export function sweepUsageProbeDirectories(root: string = tmpdir(), nowMs = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (!PROBE_DIRECTORY.test(name)) continue
    const path = join(root, name)
    try {
      const stat = lstatSync(path)
      if (
        stat.isDirectory() &&
        stat.uid === process.getuid?.() &&
        nowMs - stat.mtimeMs > SWEEP_AGE_MS
      )
        rmSync(path, { recursive: true, force: true })
    } catch {
      // Gone already, or not ours to read.
    }
  }
}

/** Fixed CLI probes with Host-owned executable resolution and credential environment. */
export function createAccountProbes(options: { env: Record<string, string>; log?: RuntimeLog }) {
  const binary = () => which('claude', options.env.PATH ?? '')
  const usage = createClaudeUsage({
    binary,
    environment: async () => options.env,
    run: async (file, env, accountId) => {
      const start = performance.now()
      const result = await usageProbe(file, env).catch(() => ({ reason: 'cwd', stdout: '' }))
      if (!result.reason) return result.stdout
      options.log?.('host', 'claude.usage.failed', {
        accountId: accountId.slice(0, 64),
        reason: result.reason,
        ms: Math.round(performance.now() - start),
      })
      return null
    },
  })
  async function status(
    _override?: string,
    extraEnv?: Record<string, string>,
  ): Promise<ClaudeStatus> {
    const file = await binary()
    if (!file)
      return { binary: { found: false }, auth: { ok: false, error: 'Claude Code not installed' } }
    const result = await probe(file, ['auth', 'status'], {
      env: { ...options.env, ...extraEnv },
      secrets: [],
      timeoutMs: 10_000,
    })
    return { binary: { found: true }, auth: parseClaudeAuthStatus(result.stdout) }
  }
  async function logout(_override?: string, extraEnv?: Record<string, string>): Promise<void> {
    const file = await binary()
    if (!file) throw new Error('Claude Code not installed')
    const result = await probe(file, ['auth', 'logout'], {
      env: { ...options.env, ...extraEnv },
      secrets: [],
      timeoutMs: 10_000,
    })
    if (result.code !== 0) throw new Error('Could not sign out')
  }
  return { status, logout, usage }
}
