import { BrowserWindow } from 'electron'
import type { LoginFlowState } from '@shared/models'
import { handle } from './handle'
import { checkSubscriptionAuth, logoutProvider } from '../pi/auth-status'
import { fetchCodexUsage } from '../pi/codex-usage'
import { cancelLogin } from '../pi/login-flow'
import { invalidatePiHealth } from '../pi/health'
import { invalidateCatalogueModels, invalidatePiCommands } from '../pi/catalogue'
import { createLoginTerminal, startLoginWithBrowser } from '../pi/auth-actions'

/**
 * Signing in or out changes the providers, so the cached catalogue no longer
 * describes what the user can pick. The command list goes too: a probe that
 * failed because pi was not ready is not cached, but one that ran against a
 * half-configured install is.
 */
function invalidateProviderCaches(): void {
  invalidateCatalogueModels()
  invalidatePiHealth()
  invalidatePiCommands()
}

function broadcastLoginState(state: LoginFlowState): void {
  if (state.phase === 'signed-in') invalidateProviderCaches()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('pi:loginState', state)
  }
}

/** Signing into the subscription providers pi supports. */
export function registerPiAuthHandlers(): void {
  handle('pi:subscriptionAuth', () => checkSubscriptionAuth())
  handle('pi:codexUsage', (_event, force) => fetchCodexUsage(force === true))

  handle('pi:startLogin', (_event, providerId) =>
    startLoginWithBrowser(providerId, broadcastLoginState),
  )

  handle('pi:cancelLogin', (_event, providerId) => {
    cancelLogin(providerId)
  })

  handle('pi:loginTerminal', (_event, cols, rows) => createLoginTerminal(cols, rows))

  handle('pi:logout', async (_event, providerId) => {
    // Even a refused sign-out may have removed the stored half.
    await logoutProvider(providerId).finally(invalidateProviderCaches)
  })
}
