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

async function usageProbe(file: string, env: NodeJS.ProcessEnv) {
  // Never use HOME or the lane workspace as a Claude project, even for the default login.
  const cwd = await mkdtemp(join(tmpdir(), 'phosphor-usage-'))
  try {
    return await runUsageCommand(runPrintMode, file, env, cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
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
