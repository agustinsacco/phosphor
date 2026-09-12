import { homedir } from 'node:os'
import { BrowserWindow, shell } from 'electron'
import type { LoginFlowState } from '@shared/models'
import { handle } from './handle'
import { checkSubscriptionAuth } from '../pi/auth-status'
import { cancelLogin, startLogin } from '../pi/login-flow'
import { checkPiHealth, invalidatePiHealth, piArgs } from '../pi/health'
import { invalidateCatalogueModels } from './pi-config-handlers'
import { piProcessEnv } from '../pi/shell-env'
import { ptyManager } from '../pty/pty-manager'

/**
 * Open the provider's authorization page.
 *
 * The URL is scraped from pi's terminal output, so it is validated the same
 * way `app:openExternal` validates a renderer-supplied one: http/https only,
 * never `file:` or a custom scheme that would hand a local handler an
 * argument. Failing closed just means the user clicks the link in the UI.
 */
function openAuthPage(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    void shell.openExternal(parsed.toString())
  } catch {
    /* unparseable — the UI still shows the raw URL */
  }
}

function broadcastLoginState(state: LoginFlowState): void {
  // Signing in adds providers, so the cached catalogue no longer describes
  // what the user can pick.
  if (state.phase === 'signed-in') {
    invalidateCatalogueModels()
    invalidatePiHealth()
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('pi:loginState', state)
  }
}

/** Signing into the subscription providers pi supports. */
export function registerPiAuthHandlers(): void {
  handle('pi:subscriptionAuth', () => checkSubscriptionAuth())

  handle('pi:startLogin', async (_event, providerId) => {
    let opened = false
    await startLogin(providerId, (state) => {
      // Open the browser once, on the first URL. The flow re-emits on repaint,
      // and a second tab mid-sign-in reads as a bug.
      if (state.phase === 'awaiting-browser' && !opened) {
        opened = true
        openAuthPage(state.url)
      }
      broadcastLoginState(state)
    })
  })

  handle('pi:cancelLogin', (_event, providerId) => {
    cancelLogin(providerId)
  })

  handle('pi:loginTerminal', async (_event, cols, rows) => {
    const health = await checkPiHealth()
    if (!health.ok || !health.binaryPath) {
      throw new Error(health.message ?? 'pi is not available')
    }
    /*
     * `--no-session` keeps this throwaway pi out of the session list — the
     * user is signing in, not starting a conversation, and a stray session
     * would show up in the sidebar. Home as cwd because sign-in has nothing
     * to do with any workspace, and pi refuses nothing there.
     */
    return ptyManager.create(homedir(), cols, rows, undefined, {
      file: health.binaryPath,
      args: piArgs(health, ['--no-session']),
      env: await piProcessEnv(),
    })
  })
}
