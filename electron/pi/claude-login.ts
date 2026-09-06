import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { ClaudeLoginState } from '@shared/models'
import { claudeStatus, resolveBinary } from './packages'
import { piProcessEnv } from './shell-env'

const execFileAsync = promisify(execFile)

/**
 * Signing the Claude Code CLI in and out from inside pidex.
 *
 * This is the account that bills a Claude Pro/Max plan (`pi-claude-cli`), and
 * until now pidex only *read* it — the tab told the user to go run `claude` in
 * a terminal and type `/login`. That is the one provider whose sign-in needs no
 * terminal at all, because unlike pi's `/login` (TUI-only, hence the pty
 * driver in `login-flow.ts`), `claude auth login` is a plain subcommand that
 * works with **piped stdio**. Verified against Claude Code 2.1.231:
 *
 *     $ printf 'code\n' | claude auth login
 *     Opening browser to sign in…
 *     If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…
 *     Paste code here if prompted > Invalid code. Please make sure the full code was copied.
 *
 * So there is no screen to classify and no keystrokes to time: read the URL off
 * stdout, let the user finish in their browser, write the code they paste back
 * into stdin. Three facts that shape the code below, all established by running
 * the real CLI:
 *
 * - **The CLI opens the browser itself.** pidex must not open it too, or the
 *   user gets two tabs and pastes the code from the stale one. The UI offers
 *   the URL as a fallback link instead.
 * - **A wrong code is not fatal.** The CLI prints `Invalid code.` and re-prompts
 *   with a *fresh* URL, so the flow returns to `awaiting-code` rather than
 *   failing — and the newest URL is the live one.
 * - **Its prose is not the outcome.** A run given a bogus code still printed
 *   `Login successful.` and exited 0. Completion is therefore decided by
 *   `claude auth status`, the same fact the rest of pidex already trusts, never
 *   by matching output. (Same principle as `login-flow.ts`.)
 */

/** How long to wait for the CLI to print its authorization URL. */
const URL_TIMEOUT_MS = 30_000
/**
 * The browser trip, restarted every time the CLI offers a URL.
 *
 * Killing the child ends the sign-in outright: the CLI is the only thing that
 * can exchange the code the user is about to paste, so a clock that expires
 * mid-browser throws away work the user has already done. Measured from the
 * newest URL, not from launch, because an invalid code makes the CLI restart
 * the handshake and the user starts the trip over.
 */
const BROWSER_TIMEOUT_MS = 15 * 60_000

/**
 * The authorization URL the CLI is currently offering, if any.
 *
 * The **last** match wins: an invalid code makes the CLI restart the OAuth
 * handshake with a new PKCE challenge, and pasting a code from the earlier URL
 * cannot succeed. The explicit `visit:` prefix is tried first, with a bare
 * oauth-URL match as a backstop for a reworded line.
 */
export function parseClaudeLoginUrl(output: string): string | undefined {
  const labelled = [...output.matchAll(/visit:\s*(https?:\/\/\S+)/gi)].at(-1)?.[1]
  if (labelled) return labelled.replace(/[.,)\]]+$/, '')
  const bare = [...output.matchAll(/https?:\/\/\S*oauth\S*/gi)].at(-1)?.[0]
  return bare?.replace(/[.,)\]]+$/, '')
}

/** Did the CLI reject the last code we sent? It re-prompts rather than exiting. */
export function hasInvalidCodeNotice(output: string): boolean {
  return /invalid code/i.test(output)
}

interface RunningLogin {
  child: ChildProcess
  submit: (code: string) => void
  cancel: () => void
}

let running: RunningLogin | null = null

/** Is a Claude sign-in in flight? */
export function claudeLoginInFlight(): boolean {
  return running !== null
}

/**
 * Start `claude auth login`, reporting each state change.
 *
 * Resolves once the process is spawned; the outcome arrives on `onState`,
 * because the middle of this is a human in a browser. Only one at a time — the
 * CLI keeps a single credential, and two handshakes racing it is a support
 * ticket waiting to happen.
 */
export async function startClaudeLogin(
  onState: (state: ClaudeLoginState) => void,
  /** E2E-only binary override; gated in the handler, as everywhere else. */
  claudeOverride?: string,
  /**
   * Credential-scoping env, so the sign-in lands in ONE account's keychain
   * entry instead of replacing the shared one. Empty for the default account.
   * See electron/claude/accounts.ts.
   */
  extraEnv?: Record<string, string>,
): Promise<void> {
  if (running) throw new Error('A Claude sign-in is already in progress.')

  const binary = claudeOverride ?? (await resolveBinary('claude'))
  if (!binary) {
    throw new Error('claude not found on your login-shell PATH. Install @anthropic-ai/claude-code.')
  }

  const child = spawn(binary, ['auth', 'login'], {
    cwd: homedir(),
    env: { ...(await piProcessEnv()), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Who was signed in before. Needed because `claude auth status` says
  // "loggedIn" for the OLD account too, so on a *switch* it cannot by itself
  // tell a completed sign-in from an abandoned one.
  const emailBefore = (await claudeStatus(claudeOverride, extraEnv).catch(() => null))?.auth.email

  let output = ''
  let settled = false
  let lastUrl: string | undefined
  let awaitingExit = false

  const emit = (state: ClaudeLoginState): void => {
    if (settled) return
    if (state.phase === 'signed-in' || state.phase === 'error' || state.phase === 'cancelled') {
      settled = true
      running = null
      clearTimeout(urlTimer)
      clearTimeout(flowTimer)
    }
    onState(state)
  }

  const readChunk = (chunk: Buffer): void => {
    output += chunk.toString()
    const url = parseClaudeLoginUrl(output)
    // An invalid code returns us to the browser step with a new URL, so the
    // notice is reported alongside it rather than as a terminal error.
    const invalid = hasInvalidCodeNotice(output)
    if (url && (url !== lastUrl || (invalid && awaitingExit))) {
      lastUrl = url
      awaitingExit = false
      clearTimeout(urlTimer)
      // Each URL restarts the browser budget: the previous one is spent, and
      // the user is beginning the trip again from this page.
      clearTimeout(flowTimer)
      flowTimer = setTimeout(onBrowserTimeout, BROWSER_TIMEOUT_MS)
      emit({ phase: 'awaiting-code', url, invalidCode: invalid })
    }
  }

  child.stdout?.on('data', readChunk)
  child.stderr?.on('data', readChunk)

  child.on('error', (error) => emit({ phase: 'error', message: error.message }))

  child.on('exit', () => {
    if (settled) return
    // The CLI's own words are unreliable (a bogus code still printed "Login
    // successful."), so ask for the fact instead — and disbelieve a "logged in"
    // that names the same account we started with after a rejected code, which
    // is the credential we never replaced rather than a new one.
    void claudeStatus(claudeOverride, extraEnv)
      .then((status) => {
        const stale = hasInvalidCodeNotice(output) && status.auth.email === emailBefore
        if (status.auth.loggedIn && !stale) emit({ phase: 'signed-in', email: status.auth.email })
        else emit({ phase: 'error', message: signOutMessage(output) })
      })
      .catch((error: unknown) =>
        emit({ phase: 'error', message: error instanceof Error ? error.message : String(error) }),
      )
  })

  // A function declaration so `readChunk`, defined above, can restart it.
  function onBrowserTimeout(): void {
    emit({
      phase: 'error',
      message:
        'Sign-in timed out waiting for your browser, so the Claude CLI was stopped. ' +
        'A code pasted now cannot be redeemed — start the sign-in again.',
    })
    child.kill()
  }

  const urlTimer = setTimeout(() => {
    emit({
      phase: 'error',
      message:
        'The Claude CLI did not offer a sign-in link. Try `claude auth login` in a terminal.',
    })
    child.kill()
  }, URL_TIMEOUT_MS)

  let flowTimer = setTimeout(onBrowserTimeout, BROWSER_TIMEOUT_MS)

  running = {
    child,
    submit: (code) => {
      awaitingExit = true
      emit({ phase: 'finishing' })
      child.stdin?.write(`${code.trim()}\n`)
    },
    cancel: () => {
      emit({ phase: 'cancelled' })
      child.kill()
    },
  }

  emit({ phase: 'starting' })
}

/** Hand the code the user copied from the browser to the waiting CLI. */
export function submitClaudeLoginCode(code: string): void {
  if (!running) throw new Error('No Claude sign-in is in progress.')
  running.submit(code)
}

/** Stop a flow started by `startClaudeLogin`. Safe when nothing is running. */
export function cancelClaudeLogin(): void {
  running?.cancel()
  running = null
}

/** Called on teardown so a half-finished sign-in cannot outlive the window. */
export function cancelAllClaudeLogins(): void {
  cancelClaudeLogin()
}

/** Sign the CLI out. Credentials are the CLI's, so this is its own subcommand. */
export async function logoutClaude(
  claudeOverride?: string,
  extraEnv?: Record<string, string>,
): Promise<void> {
  const binary = claudeOverride ?? (await resolveBinary('claude'))
  if (!binary) throw new Error('claude not found on your login-shell PATH.')
  await execFileAsync(binary, ['auth', 'logout'], {
    env: { ...(await piProcessEnv()), ...extraEnv },
    timeout: 30_000,
  })
}

/** The most useful line of a failed run, for a UI that has no terminal. */
function signOutMessage(output: string): string {
  if (hasInvalidCodeNotice(output)) return 'That code was not accepted. Try signing in again.'
  const lastLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  return lastLine?.slice(0, 200) ?? 'Sign-in did not complete.'
}
