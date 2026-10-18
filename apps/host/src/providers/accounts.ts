import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createClaudeAccounts } from '@phosphor/session-runtime/claude/accounts'
import { selectAccount, claudeAccountEnv } from '@phosphor/session-runtime/claude/routing'
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
  readOnly?: boolean
}) {
  const root = join(options.directory, 'claude-accounts')
  if (!options.readOnly) mkdirSync(root, { recursive: true, mode: 0o700 })
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
    let stat
    try {
      stat = lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return structuredClone(DEFAULT_CLAUDE_ACCOUNT_PREFS)
      throw error
    }
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
      !prefs ||
      !Array.isArray(prefs.accounts) ||
      prefs.accounts.length > 16 ||
      !['specific', 'ordered', 'round-robin'].includes(prefs.mode) ||
      !Number.isSafeInteger(prefs.cursor) ||
      prefs.cursor < 0 ||
      !prefs.bindings ||
      typeof prefs.bindings !== 'object' ||
      Array.isArray(prefs.bindings) ||
      !prefs.cooldowns ||
      typeof prefs.cooldowns !== 'object' ||
      Array.isArray(prefs.cooldowns)
    )
      throw new Error('Invalid Claude account metadata')
    for (const account of prefs.accounts)
      if (
        !validId(account.id) ||
        typeof account.label !== 'string' ||
        account.label.length > 300 ||
        account.label.includes('\0') ||
        (account.credentialDir !== null &&
          (typeof account.credentialDir !== 'string' ||
            dirname(account.credentialDir) !== root ||
            !isUuid(basename(account.credentialDir))))
      )
        throw new Error('Invalid Claude account metadata')
    const ids = new Set(prefs.accounts.map((account) => account.id))
    if (
      ids.size !== prefs.accounts.length ||
      (prefs.pinnedId !== undefined && !ids.has(prefs.pinnedId)) ||
      Object.keys(prefs.bindings).length > 10_000 ||
      Object.entries(prefs.bindings).some(
        ([path, id]) =>
          !isAbsolute(path) || path.length > 4096 || path.includes('\0') || !ids.has(id),
      ) ||
      Object.entries(prefs.cooldowns).some(
        ([id, until]) => !validId(id) || !Number.isSafeInteger(until) || until < 0,
      )
    )
      throw new Error('Invalid Claude account metadata')
    return prefs
  }
  const authorization = new AsyncLocalStorage<() => boolean>()
  function write(prefs: ClaudeAccountPrefs): void {
    if (options.readOnly) throw new Error('Claude account metadata is read-only')
    if (authorization.getStore()?.() === false) throw new Error('Configuration access was revoked')
    if (prefs.accounts.length > 16) throw new Error('Claude account limit reached')
    const serialized = JSON.stringify(prefs)
    if (Buffer.byteLength(serialized) > 512 * 1024)
      throw new Error('Claude account metadata limit reached')
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' })
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
  return {
    ...accounts,
    /** Read-only inspection never advances routing or probes/writes credentials. */
    credentialEnvironment: () =>
      claudeAccountEnv(selectAccount(read(), { nowMs: Date.now() }).account),
    usage,
    status,
    async authenticationReady(): Promise<boolean | null> {
      try {
        const prefs = await accounts.loadAccounts()
        const selected = selectAccount(prefs, { nowMs: Date.now() }).account
        const checked = await status(undefined, claudeAccountEnv(selected))
        return checked.auth.ok ? checked.auth.loggedIn === true : null
      } catch {
        return null
      }
    },
    withAuthorization: <T>(allowed: () => boolean, run: () => Promise<T>) =>
      authorization.run(allowed, run),
  }
}
export type HostClaudeAccounts = ReturnType<typeof createHostClaudeAccounts>

export function readHostClaudeEnvironment(options: {
  directory: string
  home: string
  env: Record<string, string>
}): Record<string, string> {
  const path = join(options.directory, 'claude-accounts', 'accounts.json')
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  return createHostClaudeAccounts({ ...options, readOnly: true }).credentialEnvironment()
}
