import { stripAnsi } from '@shared/ansi'
import type { AuthCheck } from '@phosphor/session-runtime/pi/provider-auth'

/**
 * The bottom of a screen, for the debug log when a step never arrives.
 *
 * Only logged before pi has produced an authorization URL, so it cannot carry
 * a code or a credential.
 */
export function screenTail(screen: string, lines = 12): string {
  return screen
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-lines)
    .join('\n')
}

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
