import { join } from 'node:path'
import { app } from 'electron'
import { createClaudeAccounts } from '@phosphor/session-runtime/claude/accounts'
import { getClaudeAccountPrefs, setClaudeAccountPrefs } from '../store'
import { claudeStatus } from '../pi/packages'
import { logoutClaude } from '../pi/claude-login'
import { cachedUsageSnapshot, clearUsageCache, fetchUsageSnapshot } from './usage'
export { claudeAccountEnv } from './routing'

export const {
  accountUsageEnv,
  loadAccounts,
  primaryAccount,
  accountForSpawn,
  bindSession,
  refreshCooldowns,
  accountViews,
  beginAddAccount,
  finishAddAccount,
  removeAccount,
  reorderAccounts,
  setRouting,
  holdAccount,
  sessionAccount,
} = createClaudeAccounts({
  get root() {
    return join(app.getPath('userData'), 'claude-accounts')
  },
  read: getClaudeAccountPrefs,
  write: setClaudeAccountPrefs,
  status: claudeStatus,
  logout: logoutClaude,
  cachedUsage: cachedUsageSnapshot,
  clearUsage: clearUsageCache,
  fetchUsage: fetchUsageSnapshot,
})
