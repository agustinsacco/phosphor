import { AsyncLocalStorage } from 'node:async_hooks'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { createClaudeAccounts } from '@phosphor/session-runtime/claude/accounts'
import { selectAccount, claudeAccountEnv } from '@phosphor/session-runtime/claude/routing'
import { createAccountReservations } from './account-reservations'
import { createAccountMetadata } from './account-metadata'
import { createAccountProbes } from './account-probes'

/** One private account domain per Host, with one mutation queue and admission domain. */
export function createHostClaudeAccounts(options: {
  directory: string
  home: string
  env: Record<string, string>
  readOnly?: boolean
}) {
  const root = join(options.directory, 'claude-accounts')
  const authorization = new AsyncLocalStorage<() => boolean>()
  const { read, write } = createAccountMetadata({
    root,
    readOnly: options.readOnly,
    allowed: () => authorization.getStore()?.() !== false,
  })
  const { status, logout, usage } = createAccountProbes(options)
  const accounts = createClaudeAccounts({
    root,
    read,
    write,
    status,
    logout,
    cachedUsage: usage.cachedUsageSnapshot,
    clearUsage: usage.clearUsageCache,
    fetchUsage: usage.fetchUsageSnapshot,
  })
  return {
    ...accounts,
    ...createAccountReservations(accounts.removeAccount),
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
