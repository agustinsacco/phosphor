import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeAccount } from '@shared/models'
import type { AccountState } from './account-state'
import { claudeAccountEnv } from './routing'

/**
 * Create the record a sign-in will fill, and hand back the env it must run
 * under. Called before `claude auth login`, not after: the CLI writes its
 * credential the moment the browser flow lands, so the directory that decides
 * *where* has to exist first.
 */
async function beginAddAccount(
  state: AccountState,
  claudeOverride?: string,
): Promise<{ id: string; env: Record<string, string> }> {
  const prefs = await state.loadAccounts(claudeOverride)
  // The very first account takes the CLI's default entry, so an install with
  // no login at all does not start by inventing a directory.
  if (prefs.accounts.length === 0) return { id: 'default', env: {} }
  const id = randomUUID()
  const dir = join(state.ports.root, id)
  mkdirSync(dir, { recursive: true })
  return { id, env: claudeAccountEnv({ credentialDir: dir } as ClaudeAccount) }
}

/**
 * Record the account a completed sign-in produced.
 *
 * Identity comes from `claude auth status` under the new credential, never
 * from the login output — the CLI prints "Login successful." for a rejected
 * code too (see `claude-login.ts`). A sign-in that did not actually land
 * leaves no account behind.
 */
async function finishAddAccount(
  state: AccountState,
  id: string,
  claudeOverride?: string,
): Promise<ClaudeAccount | null> {
  const { status: claudeStatus, clearUsage: clearUsageCache } = state.ports
  const prefs = await state.loadAccounts(claudeOverride)
  const existing = prefs.accounts.find((a) => a.id === id)
  const credentialDir = existing
    ? existing.credentialDir
    : id === 'default'
      ? null
      : join(state.ports.root, id)
  const status = await claudeStatus(
    claudeOverride,
    claudeAccountEnv({ credentialDir } as ClaudeAccount),
  ).catch(() => null)
  if (status?.auth.loggedIn !== true) return null

  // The same email AND organization is a re-authentication, not a
  // second plan. A different organization is a different billing identity.
  // Two rows for one subscription would
  // make round-robin spread load across nothing and double-count its quota.
  // The row keeps its id and place and takes the NEW credential directory,
  // because that is where the CLI just wrote the working token.
  const duplicate =
    !existing && status.auth.email
      ? prefs.accounts.find(
          (a) =>
            a.email?.toLowerCase() === status.auth.email?.toLowerCase() &&
            a.orgId === status.auth.orgId,
        )
      : undefined
  const target = existing ?? duplicate
  const emailCollision =
    !target &&
    status.auth.email &&
    prefs.accounts.some((a) => a.email?.toLowerCase() === status.auth.email?.toLowerCase())
  const newLabel = emailCollision
    ? `${status.auth.email!.slice(0, 160)} · ${(status.auth.organization || 'Organization').slice(0, 64)} · ${id.slice(0, 8)}`
    : (status.auth.email ?? 'Claude account')

  const account: ClaudeAccount = {
    id: target?.id ?? id,
    label: target?.label ?? newLabel,
    ...(status.auth.email ? { email: status.auth.email } : {}),
    ...(status.auth.plan ? { plan: status.auth.plan } : {}),
    ...(status.auth.organization ? { organization: status.auth.organization } : {}),
    ...(status.auth.orgId ? { orgId: status.auth.orgId } : {}),
    credentialDir,
    addedAt: target?.addedAt ?? Date.now(),
  }
  const accounts = target
    ? prefs.accounts.map((a) => (a.id === target.id ? account : a))
    : [...prefs.accounts, account]
  state.save({ ...prefs, accounts, pinnedId: prefs.pinnedId ?? account.id })
  clearUsageCache(account.id)
  return account
}

/** Sign an account out and forget it. Its credential dir is left in place. */
async function removeAccount(
  state: AccountState,
  id: string,
  claudeOverride?: string,
): Promise<void> {
  const { logout: logoutClaude, clearUsage: clearUsageCache } = state.ports
  const prefs = await state.loadAccounts(claudeOverride)
  const account = prefs.accounts.find((a) => a.id === id)
  if (!account) return
  // Best effort: a logout that fails must not strand the row in the UI.
  await logoutClaude(claudeOverride, claudeAccountEnv(account)).catch(() => undefined)
  const accounts = prefs.accounts.filter((a) => a.id !== id)
  state.save({
    ...prefs,
    accounts,
    ...(prefs.pinnedId === id ? { pinnedId: accounts[0]?.id } : {}),
  })
  clearUsageCache(id)
}

/** Reorder by id. Ids not in the list are appended, unknown ones ignored. */
async function reorderAccounts(
  state: AccountState,
  ids: string[],
  claudeOverride?: string,
): Promise<void> {
  const prefs = await state.loadAccounts(claudeOverride)
  const byId = new Map(prefs.accounts.map((a) => [a.id, a]))
  const ordered = ids.flatMap((id) => {
    const account = byId.get(id)
    if (!account) return []
    byId.delete(id)
    return [account]
  })
  state.save({ ...prefs, accounts: [...ordered, ...byId.values()] })
}

export function createAccountLifecycle(state: AccountState) {
  return {
    beginAddAccount: beginAddAccount.bind(null, state),
    finishAddAccount: finishAddAccount.bind(null, state),
    removeAccount: removeAccount.bind(null, state),
    reorderAccounts: reorderAccounts.bind(null, state),
  }
}
