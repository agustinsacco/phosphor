import { homedir } from 'node:os'
import { stripAnsi } from '@shared/ansi'
import type { LoginFlowState, LoginProviderId } from '@shared/models'
import { checkPiHealth } from './health'
import { piProcessEnv } from './shell-env'
import { ptyManager } from '../pty/pty-manager'
import { type AuthCheck, checkProviderAuth } from './auth-status'

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

/** How long to wait for each expected screen before giving up. */
const STEP_TIMEOUT_MS = 20_000
/**
 * Driving the TUI from launch to an authorization URL. Machine-speed, so a
 * generous ceiling here is still a fast failure.
 */
const SETUP_TIMEOUT_MS = 2 * 60_000
/**
 * The browser trip, measured from the moment pi hands us a URL.
 *
 * Deliberately long, and deliberately separate from the setup budget. Ending
 * this flow kills the pty, and for a loopback-redirect provider that pty *is*
 * the callback server — pi listens on `localhost` and the browser completes
 * the exchange against it. So a timeout here does not merely abandon the
 * sign-in, it tears down the port the user's browser is about to redirect to,
 * and they get `ERR_CONNECTION_REFUSED` on a URL that looks perfectly valid.
 *
 * One five-minute clock used to cover setup *and* the browser, which is less
 * than an SSO round trip with MFA and an account picker. Real symptom, on
 * OpenAI Codex (loopback port 1455): the tab said "Sign-in timed out" while
 * the browser said the site could not be reached, and neither named the cause.
 */
const BROWSER_TIMEOUT_MS = 15 * 60_000
/** How often to re-read the terminal for a state change. */
const POLL_MS = 250
/** How often to ask pi whether the sign-in has landed. */
const VERIFY_INTERVAL_MS = 2_000
/** Width of the hidden terminal. See the note where the pty is created. */
const TERMINAL_COLS = 1000

const CR = String.fromCharCode(13)
/** Written to the pty to cancel a pending device-code request. */
const ESC = String.fromCharCode(27)

/**
 * A pty screen as plain text.
 *
 * Escape removal is `@shared/ansi`'s — this used to be a second, narrower
 * `stripAnsi` here (CSI plus terminated OSC only), which is exactly the kind
 * of near-duplicate that drifts. What is specific to reading a *screen* is the
 * carriage-return handling: the TUI redraws a line by returning to its start,
 * so a bare CR separates two states of the same row and must read as a line
 * break, not as a join.
 */
export function screenText(raw: string): string {
  return stripAnsi(raw).split('\r').join('\n')
}

/**
 * The authorization URL and its device code, if this screen is showing them.
 *
 * Matched independently rather than as one block: the URL and the `Enter code:`
 * line are several rows apart and the TUI redraws between them, so requiring
 * them adjacent would miss the frame where only one had painted.
 *
 * `userCode` is absent for providers that use a loopback redirect instead of a
 * device code (Anthropic does): pi listens on `localhost` and the browser
 * completes the sign-in by itself, so there is nothing for the user to type.
 *
 * The character class excludes non-ASCII deliberately — the TUI pads lines
 * with box-drawing rules, and `─` is not whitespace.
 */
export function parseAuthPrompt(screen: string): { url: string; userCode?: string } | null {
  const url = /https?:\/\/[!-~]*(?:oauth|auth|login|device|activate)[!-~]*/i.exec(screen)?.[0]
  if (!url) return null
  const userCode = /Enter code:\s*([A-Z0-9][A-Z0-9-]{3,})/i.exec(screen)?.[1]
  return userCode ? { url, userCode } : { url }
}

/**
 * Which screen the TUI is currently showing.
 *
 * Both sign-in shapes count as `awaiting-auth`, because from here they are the
 * same state — pi has produced a URL and is waiting on the browser:
 *
 * - device code (xAI): `Enter code: ABCD-1234` / `Waiting for authentication...`
 * - loopback redirect (Anthropic): `Complete login in your browser`, with pi
 *   listening on a `localhost` callback port
 */
export function classifyScreen(
  screen: string,
):
  'auth-method' | 'provider-list' | 'login-method' | 'host-question' | 'awaiting-auth' | 'unknown' {
  // Ordered most-specific first: the provider list and the auth prompt can
  // both still have the earlier prompt in scrollback above them.
  // `Cmd+click to open` is pi's own "here is a URL" affordance and the one
  // string every provider's prompt shares — the prose around it does not
  // (Anthropic says "Complete login", OpenRouter "Complete sign-in", xAI
  // neither). Ctrl+click on Linux. The wordier patterns stay as backstops in
  // case that hint is ever dropped.
  const awaitingAuth =
    /(?:Cmd|Ctrl)\+click to open/i.test(screen) ||
    /Waiting for authentication|Enter code:/i.test(screen) ||
    /Complete (?:log|sign)[\s-]?in in your browser/i.test(screen)
  if (awaitingAuth) return 'awaiting-auth'
  if (/GitHub Enterprise URL\/domain/i.test(screen)) return 'host-question'
  // Before provider-list: this screen still has the provider list above it.
  // Matched on the preselected option rather than the heading, because the
  // heading is per-provider prose ("Select OpenAI Codex login method:" vs
  // "Sign in to Radius:") while the browser option is worded consistently.
  if (/Browser login|Sign in with browser|Select .{0,40} login method:/i.test(screen)) {
    return 'login-method'
  }
  if (/Select provider to configure/i.test(screen)) return 'provider-list'
  if (/Select authentication method/i.test(screen)) return 'auth-method'
  return 'unknown'
}

/**
 * Which budget, if either, this flow has run past.
 *
 * Split in two because the two halves fail for different reasons and deserve
 * different patience: reaching the URL is pi's work and should be quick, while
 * everything after it is a human in a browser. `authAt` is when the URL was
 * first emitted, or null if it has not been.
 */
export function expiredBudget(
  now: number,
  startedAt: number,
  authAt: number | null,
): 'setup' | 'browser' | null {
  if (authAt === null) return now - startedAt > SETUP_TIMEOUT_MS ? 'setup' : null
  return now - authAt > BROWSER_TIMEOUT_MS ? 'browser' : null
}

/**
 * Did this flow produce a *new* credential, or is `auth check` still answering
 * with the one that was already stored?
 *
 * Completion cannot be "the provider is ready", because switching accounts
 * starts from a provider that is already ready. `auth check` answers `ready`
 * from the old credential the first time it is asked — about a second after pi
 * prints the authorization URL — so the flow declared success, and `finish()`
 * killed the pty while the user was still on the provider's page. For a
 * loopback provider that pty *is* the callback server: OpenAI Codex redirects
 * to `http://localhost:1455/auth/callback`, and the browser got
 * `ERR_CONNECTION_REFUSED` on a URL carrying a perfectly good code. The
 * account never changed, because the exchange that would have changed it had
 * nowhere to land.
 *
 * So the fact to wait for is the credential *changing*. A first sign-in is any
 * `ready`; a re-sign-in must produce a different fingerprint — which a second
 * sign-in to the same account also does, since the provider issues a new token.
 *
 * When pi hands over no credential to fingerprint, this stays `false` rather
 * than guessing: an unbounded wait ends at the browser budget, whereas a wrong
 * `true` closes the port the user is mid-sign-in against.
 */
export function isNewCredential(before: AuthCheck, after: AuthCheck): boolean {
  if (after.status !== 'ready') return false
  if (before.status !== 'ready') return true
  if (!before.fingerprint || !after.fingerprint) return false
  return before.fingerprint !== after.fingerprint
}

/** What to tell the user when a budget runs out. */
export function timeoutMessage(budget: 'setup' | 'browser'): string {
  return budget === 'setup'
    ? 'pi did not reach a sign-in page. Use “Open pi’s login terminal” below to finish it by hand.'
    : 'Sign-in timed out waiting for your browser, so Phosphor closed pi’s callback server. ' +
        'If your browser now says it cannot reach localhost, that is why — start the sign-in again.'
}

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

export interface LoginFlowHandle {
  cancel: () => void
}

interface RunningFlow extends LoginFlowHandle {
  ptyId: string
}

const running = new Map<LoginProviderId, RunningFlow>()

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
  const { ptyId } = ptyManager.create(homedir(), TERMINAL_COLS, 40, undefined, {
    file: health.binaryPath,
    args: ['--no-session'],
    env: await piProcessEnv(),
  })

  let cancelled = false
  let settled = false
  let sentLogin = false
  let sentMethod = false
  let sentProvider = false
  let answeredHost = false
  let sentLoginMethod = false
  let lastAuth: { url: string; userCode?: string } | null = null
  /** When pi first produced a URL — the start of the browser budget. */
  let authAt: number | null = null
  let verifying = false
  let lastVerifyAt = 0
  let stepStartedAt = Date.now()
  const startedAt = Date.now()

  const emit = (state: LoginFlowState): void => {
    if (settled && state.phase !== 'cancelled') return
    if (state.phase === 'signed-in' || state.phase === 'error' || state.phase === 'cancelled') {
      settled = true
    }
    onState(state)
  }

  const finish = (state: LoginFlowState): void => {
    emit(state)
    running.delete(providerId)
    clearInterval(timer)
    ptyManager.kill(ptyId)
  }

  const timer = setInterval(() => {
    if (cancelled) return
    // `attach` is a pure read of the buffer — no side effects on the pty.
    const screen = screenText(ptyManager.attach(ptyId).scrollback)

    const expired = expiredBudget(Date.now(), startedAt, authAt)
    if (expired) {
      finish({ providerId, phase: 'error', message: timeoutMessage(expired) })
      return
    }

    const step = classifyScreen(screen)

    // pi's TUI drops keystrokes typed before it has painted, and offers no
    // ready signal. Rather than the fixed delay this replaces, each step is
    // sent only once its own screen is actually on the terminal.
    if (!sentLogin) {
      // The prompt line is the first thing pi paints once it accepts input.
      if (/›|>|Describe|pi |MCP:/i.test(screen)) {
        sentLogin = true
        stepStartedAt = Date.now()
        ptyManager.write(ptyId, `/login${CR}`)
      }
    } else if (step === 'auth-method' && !sentMethod) {
      sentMethod = true
      stepStartedAt = Date.now()
      // "Sign in with an account" is preselected — subscription auth is the
      // whole point here, so Enter takes it.
      ptyManager.write(ptyId, CR)
    } else if (step === 'provider-list' && !sentProvider) {
      sentProvider = true
      stepStartedAt = Date.now()
      emit({ providerId, phase: 'starting' })
      // Filter by label rather than arrowing: pi controls the list order and
      // it changes as providers are added.
      ptyManager.write(ptyId, label)
      setTimeout(() => {
        if (!cancelled) ptyManager.write(ptyId, CR)
      }, 400)
    } else if (step === 'login-method' && !sentLoginMethod) {
      sentLoginMethod = true
      stepStartedAt = Date.now()
      // OpenAI Codex asks browser-vs-device-code. "Browser login" is both the
      // preselected default and the better fit here, since Phosphor opens the
      // user's real browser — where they are already signed in.
      ptyManager.write(ptyId, CR)
    } else if (step === 'host-question' && !answeredHost) {
      answeredHost = true
      stepStartedAt = Date.now()
      // Copilot asks for a GitHub Enterprise host, and blank means github.com —
      // which is the account almost everyone signing in here has. An Enterprise
      // host cannot be guessed, so that case takes the login-terminal escape
      // hatch, and the provider's caveat in auth-status.ts says so.
      ptyManager.write(ptyId, CR)
    } else if (step === 'awaiting-auth') {
      const auth = parseAuthPrompt(screen)
      // Re-emit only when it actually changes: the TUI repaints constantly and
      // a status that rewrites itself would restart the browser open.
      if (auth && (!lastAuth || auth.url !== lastAuth.url || auth.userCode !== lastAuth.userCode)) {
        lastAuth = auth
        stepStartedAt = Date.now()
        // A new URL is a new browser trip, so the browser budget starts here
        // rather than at launch. The change guard above is what stops a repaint
        // from extending it indefinitely.
        authAt = Date.now()
        emit({ providerId, phase: 'awaiting-browser', url: auth.url, userCode: auth.userCode })
      }
    }

    // Completion is asked of pi, not read off the screen. The TUI announces
    // success in prose that could change wording at any release, whereas
    // `auth check` is the same fact the rest of Phosphor already trusts.
    // Throttled well below the poll rate: each check is a `pi` subprocess, and
    // the thing being waited on is a human in a browser.
    if (lastAuth && !verifying && Date.now() - lastVerifyAt >= VERIFY_INTERVAL_MS) {
      verifying = true
      lastVerifyAt = Date.now()
      void checkProviderAuth(providerId)
        .then((result) => {
          // Against the baseline, never `ready` alone — see `isNewCredential`.
          if (isNewCredential(before, result) && !settled) {
            finish({ providerId, phase: 'signed-in' })
          }
        })
        .catch(() => {
          /* transient; the next tick asks again */
        })
        .finally(() => {
          verifying = false
        })
    }

    // A step that never arrives is a real failure, not a hang. Skipped once
    // the browser has the URL, because that step waits on a human.
    if (!lastAuth && Date.now() - stepStartedAt > STEP_TIMEOUT_MS) {
      finish({
        providerId,
        phase: 'error',
        message:
          'pi stopped at a screen this sign-in does not know how to answer. ' +
          'Use “Open pi’s login terminal” below to finish it by hand.',
      })
    }
  }, POLL_MS)

  const handle: RunningFlow = {
    ptyId,
    cancel: () => {
      if (cancelled || settled) return
      cancelled = true
      // Escape lets pi tear down its pending device-code request; killing the
      // pty would leave that dangling on the provider's side.
      try {
        ptyManager.write(ptyId, ESC)
      } catch {
        /* pty already gone */
      }
      finish({ providerId, phase: 'cancelled' })
    },
  }

  running.set(providerId, handle)
  emit({ providerId, phase: 'starting' })
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
