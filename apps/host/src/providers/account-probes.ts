import { createClaudeUsage } from '@phosphor/session-runtime/claude/usage'
import { parseClaudeAuthStatus } from '@phosphor/session-runtime/claude/auth-status'
import { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import type { ClaudeStatus } from '@phosphor/shared/models'
import { which } from '../machine/executables'
import { probe } from '../machine/probe'

/** Fixed CLI probes with Host-owned executable resolution and credential environment. */
export function createAccountProbes(options: { home: string; env: Record<string, string> }) {
  const binary = () => which('claude', options.env.PATH ?? '')
  const usage = createClaudeUsage({
    binary,
    environment: async () => options.env,
    run: async (file, env) => {
      const result = await runPrintMode(
        file,
        ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
        { cwd: options.home, env, timeoutMs: 20_000 },
      )
      return result.error ? null : result.stdout
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
