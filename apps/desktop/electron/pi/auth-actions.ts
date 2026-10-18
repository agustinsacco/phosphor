import { shell } from 'electron'
import type { LoginFlowState, LoginProviderId } from '@shared/models'
import { externalUrl } from '../external-links'
import { ptyManager } from '../pty/pty-manager'
import { checkPiHealth, piArgs } from './health'
import { LOGIN_TERMINAL_ARGS, signInCwd, startLogin } from './login-flow'
import { piProcessEnv } from './shell-env'

/** Scraped provider URLs follow the same policy as every other external link. */
function openAuthPage(url: string): void {
  try {
    const target = externalUrl(url)
    if (target) void shell.openExternal(target)
  } catch {
    /* The UI still shows the raw URL if opening it fails synchronously. */
  }
}

/** Each sign-in opens only its first browser prompt, but reports every repaint. */
export async function startLoginWithBrowser(
  providerId: LoginProviderId,
  onState: (state: LoginFlowState) => void,
): Promise<void> {
  let opened = false
  await startLogin(providerId, (state) => {
    if (state.phase === 'awaiting-browser' && !opened) {
      opened = true
      openAuthPage(state.url)
    }
    onState(state)
  })
}

/** A hand-driven sign-in keeps extensions, but never creates a session or project prompt. */
export async function createLoginTerminal(cols: number, rows: number): Promise<{ ptyId: string }> {
  // Bypass resolvePiInvoker: interactive auth needs a fresh health probe.
  const health = await checkPiHealth()
  if (!health.ok || !health.binaryPath) {
    throw new Error(health.message ?? 'pi is not available')
  }
  // An empty folder plus --no-approve avoids project trust questions from home.
  return ptyManager.create(signInCwd(), cols, rows, undefined, {
    file: health.binaryPath,
    args: piArgs(health, LOGIN_TERMINAL_ARGS),
    env: await piProcessEnv(),
  })
}
