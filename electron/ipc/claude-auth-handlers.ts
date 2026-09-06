import { app, BrowserWindow } from 'electron'
import type { ClaudeLoginState } from '@shared/models'
import { handle } from './handle'
import {
  cancelClaudeLogin,
  logoutClaude,
  startClaudeLogin,
  submitClaudeLoginCode,
} from '../pi/claude-login'
import { fetchUsageSnapshot } from '../claude/usage'
import {
  accountViews,
  beginAddAccount,
  bindSession,
  claudeAccountEnv,
  finishAddAccount,
  loadAccounts,
  refreshCooldowns,
  removeAccount,
  reorderAccounts,
  sessionAccount,
  setRouting,
} from '../claude/accounts'
import { spawnAccountFor, spawnAccountSessions } from '../pi/session-accounts'

function broadcast(state: ClaudeLoginState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('claude:loginState', state)
  }
}

/**
 * E2E-only claude override, same gating as `packages-handlers`: an env-var
 * binary may only stand in for the real one in unpackaged builds, or it is
 * env-var-triggered code execution in a shipped app.
 */
function claudeBinOverride(): string | undefined {
  if (app.isPackaged) return undefined
  return process.env.PIDEX_CLAUDE_BIN || undefined
}

/**
 * Signing the Claude Code CLI in and out (the plan-billed provider).
 *
 * Separate from `pi-auth-handlers` because the credential lives somewhere else:
 * these channels drive the `claude` binary's own auth, not pi's `auth.json`.
 * No `openExternal` here on purpose — the CLI opens the browser itself, and a
 * second tab is one the user could paste a stale code from.
 */
export function registerClaudeAuthHandlers(): void {
  handle('claude:startLogin', async (_event, accountId) => {
    const override = claudeBinOverride()
    // The credential directory has to exist before the CLI writes to it, so
    // the account record is opened here and only *kept* if `auth status`
    // afterwards says a login actually landed.
    const target = accountId
      ? { id: accountId, env: await accountEnvFor(accountId) }
      : await beginAddAccount(override)
    await startClaudeLogin(
      (state) => {
        if (state.phase === 'signed-in') {
          void finishAddAccount(target.id, override).finally(() => broadcast(state))
          return
        }
        broadcast(state)
      },
      override,
      target.env,
    )
  })
  handle('claude:submitCode', (_event, code) => {
    submitClaudeLoginCode(code)
  })
  handle('claude:cancelLogin', () => {
    cancelClaudeLogin()
  })
  handle('claude:logout', () => logoutClaude(claudeBinOverride()))
  /** Read-only, cached ~60 s in main *per account*; the spawn is zero-quota. */
  handle('claude:usageSnapshot', async (_event, accountId) => {
    const override = claudeBinOverride()
    return fetchUsageSnapshot({
      ...(override ? { claudeOverride: override } : {}),
      ...(accountId ? { cacheKey: accountId, extraEnv: await accountEnvFor(accountId) } : {}),
    })
  })

  handle('claude:accounts', () => accountViews(claudeBinOverride()))
  handle('claude:removeAccount', (_event, id) => removeAccount(id, claudeBinOverride()))
  handle('claude:reorderAccounts', (_event, ids) => reorderAccounts(ids, claudeBinOverride()))
  handle('claude:setRouting', (_event, mode, pinnedId) =>
    setRouting(mode, pinnedId, claudeBinOverride()),
  )
  handle('claude:refreshAccountUsage', async () => {
    const override = claudeBinOverride()
    await refreshCooldowns(override)
    return accountViews(override)
  })
  handle('claude:bindSession', async (_event, sessionPath, pidexSessionId) => {
    const accountId = spawnAccountFor(pidexSessionId)
    if (accountId) await bindSession(sessionPath, accountId)
  })
  // Moving a running lane is dispose-and-resume in the renderer; main only
  // records where the next spawn should land. See shared/ipc.ts.
  handle('claude:assignSession', (_event, sessionPath, accountId) =>
    bindSession(sessionPath, accountId),
  )
  handle('claude:accountSessions', () => spawnAccountSessions())
  handle('claude:sessionAccount', (_event, pidexSessionId, sessionPath) =>
    sessionAccount({
      accountId: spawnAccountFor(pidexSessionId),
      sessionPath,
      claudeOverride: claudeBinOverride(),
    }),
  )
}

/** Credential env for one stored account, or none when the id is unknown. */
async function accountEnvFor(id: string): Promise<Record<string, string>> {
  const prefs = await loadAccounts(claudeBinOverride())
  return claudeAccountEnv(prefs.accounts.find((a) => a.id === id) ?? null)
}
