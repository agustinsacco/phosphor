import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createClaudeAccounts } from '@phosphor/session-runtime/claude/accounts'
import { parseClaudeAuthStatus } from '@phosphor/session-runtime/claude/auth-status'
import { createClaudeUsage } from '@phosphor/session-runtime/claude/usage'
import { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import {
  DEFAULT_CLAUDE_ACCOUNT_PREFS,
  type ClaudeAccountPrefs,
  type ClaudeStatus,
} from '@phosphor/shared/models'
import { isUuid } from '@phosphor/shared/control-api'
import { which } from '../machine/executables'
import { probe } from '../machine/probe'

/** Metadata only. Claude itself owns each credential in its keychain or private file. */
export function createHostClaudeAccounts(options: {
  directory: string
  home: string
  env: Record<string, string>
}) {
  const root = join(options.directory, 'claude-accounts')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const dir = lstatSync(root)
  if (
    dir.isSymbolicLink() ||
    !dir.isDirectory() ||
    (dir.mode & 0o077) !== 0 ||
    (process.getuid && dir.uid !== process.getuid())
  )
    throw new Error('Claude account directory must be private')
  const path = join(root, 'accounts.json')
  const validId = (id: unknown): id is string =>
    id === 'default' || (typeof id === 'string' && isUuid(id))
  function read(): ClaudeAccountPrefs {
    if (!existsSync(path)) return structuredClone(DEFAULT_CLAUDE_ACCOUNT_PREFS)
    const stat = lstatSync(path)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 512 * 1024 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Claude account metadata must be private')
    const prefs = JSON.parse(readFileSync(path, 'utf8')) as ClaudeAccountPrefs
    if (
      !Array.isArray(prefs.accounts) ||
      prefs.accounts.length > 16 ||
      !['specific', 'ordered', 'round-robin'].includes(prefs.mode) ||
      !Number.isSafeInteger(prefs.cursor) ||
      !prefs.bindings ||
      !prefs.cooldowns
    )
      throw new Error('Invalid Claude account metadata')
    for (const account of prefs.accounts)
      if (
        !validId(account.id) ||
        typeof account.label !== 'string' ||
        (account.credentialDir !== null &&
          (typeof account.credentialDir !== 'string' ||
            dirname(account.credentialDir) !== root ||
            !isUuid(basename(account.credentialDir))))
      )
        throw new Error('Invalid Claude account metadata')
    return prefs
  }
  function write(prefs: ClaudeAccountPrefs): void {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(prefs), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, path)
    } finally {
      try {
        unlinkSync(temporary)
      } catch {
        /* renamed or not created */
      }
    }
  }
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
  const accounts = createClaudeAccounts({
    root,
    read,
    write,
    status,
    logout: async (_override, extraEnv) => {
      const file = await binary()
      if (!file) throw new Error('Claude Code not installed')
      const result = await probe(file, ['auth', 'logout'], {
        env: { ...options.env, ...extraEnv },
        secrets: [],
        timeoutMs: 10_000,
      })
      if (result.code !== 0) throw new Error('Could not sign out')
    },
    cachedUsage: usage.cachedUsageSnapshot,
    clearUsage: usage.clearUsageCache,
    fetchUsage: usage.fetchUsageSnapshot,
  })
  return { ...accounts, usage, status }
}
export type HostClaudeAccounts = ReturnType<typeof createHostClaudeAccounts>
