import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { LoginFlowState, LoginProviderId } from '@shared/models'
import { checkPiHealth, piArgs } from './health'
import { piProcessEnv } from './shell-env'
import { ptyManager } from '../pty/pty-manager'
import { checkProviderAuth } from './auth-status'
import { startLoginDriver, type LoginFlowHandle } from './login-driver'

export type { LoginFlowHandle } from './login-driver'
export {
  screenText,
  parseAuthPrompt,
  classifyScreen,
  screenTail,
  expiredBudget,
  isNewCredential,
  timeoutMessage,
} from './login-screen'

/**
 * Signing into a pi provider without making the user drive a terminal.
 *
 * pi's `/login` is TUI-only: there is no `pi auth login`, no RPC command, and
 * the provider registry is not a package export. So a pty is the only door —
 * but it does not have to be a door the *user* walks through. This drives that
 * TUI off-screen and reports structured state, so the UI can be a button, a
 * browser tab, and a row that flips to "Signed in".
 *
 * Everything here was established by driving the real TUI (pi 0.84.1); the
 * screens below are quoted from that capture, because this file is a parser
 * for someone else's rendering and the shapes are the whole contract:
 *
 *     Select authentication method:
 *     → Sign in with an account
 *       Sign in with an API key
 *
 *     Select provider to configure:
 *     → Anthropic • unconfigured
 *       OpenAI Codex ✓ stored
 *
 * Providers then split into two sign-in shapes, and both had to be handled —
 * the first version of this file only knew the device-code one and hung
 * forever on Anthropic. Device code (xAI):
 *
 *     Login to xAI
 *     https://accounts.x.ai/oauth2/device?user_code=8G95-72AD
 *     Cmd+click to open
 *     Enter code: 8G95-72AD
 *     Waiting for authentication...
 *
 * Loopback redirect (Anthropic) — no code, because pi runs a callback server
 * and the browser finishes the exchange by itself:
 *
 *     Login to Anthropic
 *     https://claude.ai/oauth/authorize?…&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback&…
 *     Cmd+click to open
 *     Complete login in your browser. If the browser is on another machine, …
 *
 * Two consequences worth knowing before editing:
 *
 * - The device code, where there is one, must reach the user — not just the
 *   URL, or they get a browser page they cannot complete.
 * - pi does **not** open the browser ("Cmd+click to open"), so Phosphor does.
 *   That is a feature: the login lands in the user's real browser, where they
 *   are already signed in, instead of an embedded view.
 */

/**
 * Where a sign-in pi runs: an empty folder of Phosphor's own.
 *
 * Not the home folder, which is what this used to be. pi treats its cwd as a
 * project, and project config in home (MCP servers, once) can open a startup
 * dialog. The driver typed `/login⏎` into that dialog (Enter picks "Don't
 * allow"), so `/login` never ran and the flow sat on "Starting pi’s sign-in…"
 * until the step timeout. The dialog comes back whenever that file changes,
 * so it is not a one-off. Signing in has nothing to do with any project.
 */
export function signInCwd(): string {
  const dir = join(app.getPath('userData'), 'pi-sign-in')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * pi flags for the off-screen sign-in.
 *
 * `--no-approve` ignores project-local files, so no project trust dialog can
 * appear. `--no-extensions` keeps every user extension out: none of them is
 * needed to sign in (all of `TUI_LABELS` are pi built-ins), any of them can
 * open a startup dialog this driver cannot answer, and without it a sign-in
 * also started every configured MCP server. The login terminal keeps
 * extensions, because a human is there to answer them.
 */
export const SIGN_IN_ARGS = ['--no-session', '--no-approve', '--no-extensions']

/** pi flags for the hand-driven login terminal. See `SIGN_IN_ARGS`. */
export const LOGIN_TERMINAL_ARGS = ['--no-session', '--no-approve']

/**
 * Providers pi offers on its "Sign in with an account" screen, keyed by the
 * label it renders. Typing the label filters the list, which is how a
 * provider is chosen without counting arrow-key presses against a list whose
 * order pi controls.
 */
const TUI_LABELS: Record<LoginProviderId, string> = {
  anthropic: 'Anthropic',
  'openai-codex': 'OpenAI Codex',
  'github-copilot': 'GitHub Copilot',
  'kimi-for-coding': 'Kimi For Coding',
  openrouter: 'OpenRouter',
  radius: 'Radius',
  xai: 'xAI',
}

const running = new Map<LoginProviderId, LoginFlowHandle>()

/** Is a login already in flight for this provider? */
export function loginInFlight(providerId: LoginProviderId): boolean {
  return running.has(providerId)
}

/**
 * Drive `/login` for one provider, reporting each state change.
 *
 * `onState` is called with every transition; the caller broadcasts them. The
 * returned handle cancels the flow, which sends the TUI's own escape rather
 * than killing the pty outright — pi cleans up its pending device request
 * that way.
 */
export async function startLogin(
  providerId: LoginProviderId,
  onState: (state: LoginFlowState) => void,
): Promise<LoginFlowHandle> {
  if (running.has(providerId)) {
    throw new Error('A sign-in is already in progress for this provider.')
  }

  const label = TUI_LABELS[providerId]
  if (!label) throw new Error(`Unknown provider: ${providerId}`)

  const health = await checkPiHealth()
  if (!health.ok || !health.binaryPath) {
    throw new Error(health.message ?? 'pi is not available')
  }

  // What "signed in" looked like *before* this attempt, so completion can be
  // "the credential changed" rather than "the provider is ready". Read once,
  // here, because from the moment the pty starts pi may rewrite it.
  const before = await checkProviderAuth(providerId)

  // Absurdly wide on purpose. Nothing renders this pty, but pi hard-wraps its
  // output to the reported width, and a wrapped URL is a *broken* URL — there
  // is no reliable way to rejoin continuation lines, because the break lands
  // mid-token with no marker. Anthropic's authorize URL is ~330 characters
  // (it carries a redirect_uri, scopes and a PKCE challenge), and 160 columns
  // split it across three lines. Wider than any URL is the fix.
  const { ptyId } = ptyManager.create(signInCwd(), 1000, 40, undefined, {
    file: health.binaryPath,
    args: piArgs(health, SIGN_IN_ARGS),
    env: await piProcessEnv(),
  })

  const handle = startLoginDriver({
    providerId,
    label,
    ptyId,
    before,
    onState,
    onFinish: () => {
      running.delete(providerId)
    },
  })
  running.set(providerId, handle)
  onState({ providerId, phase: 'starting' })
  return handle
}

/** Stop a flow started by `startLogin`. Safe when nothing is running. */
export function cancelLogin(providerId: LoginProviderId): void {
  running.get(providerId)?.cancel()
}

/** Called on teardown so a half-finished sign-in cannot outlive the window. */
export function cancelAllLogins(): void {
  for (const providerId of [...running.keys()]) cancelLogin(providerId as LoginProviderId)
}
