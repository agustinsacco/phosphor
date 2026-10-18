import type { ChildProcess } from 'node:child_process'
import type { ClaudeLoginState, ClaudeStatus } from '@shared/models'

/** How long to wait for the CLI to print its authorization URL. */
const URL_TIMEOUT_MS = 30_000
/** Restart the browser trip's budget whenever the CLI offers a URL. */
const BROWSER_TIMEOUT_MS = 15 * 60_000

interface LoginAttemptOptions {
  child: ChildProcess
  emailBefore: string | undefined
  onState: (state: ClaudeLoginState) => void
  onSettled: () => void
  getStatus: () => Promise<ClaudeStatus>
}

export interface LoginAttempt extends LoginAttemptOptions {
  output: string
  settled: boolean
  lastUrl: string | undefined
  awaitingExit: boolean
  urlTimer: ReturnType<typeof setTimeout> | undefined
  flowTimer: ReturnType<typeof setTimeout> | undefined
}

/** Bind only after the caller has spawned the CLI and read the baseline status. */
export function createLoginAttempt(options: LoginAttemptOptions): LoginAttempt {
  const attempt: LoginAttempt = {
    ...options,
    output: '',
    settled: false,
    lastUrl: undefined,
    awaitingExit: false,
    urlTimer: undefined,
    flowTimer: undefined,
  }
  attempt.child.stdout?.on('data', (chunk: Buffer) => readChunk(attempt, chunk))
  attempt.child.stderr?.on('data', (chunk: Buffer) => readChunk(attempt, chunk))
  attempt.child.on('error', (error) =>
    emitLoginState(attempt, { phase: 'error', message: error.message }),
  )
  attempt.child.on('exit', () => onExit(attempt))
  attempt.urlTimer = setTimeout(() => {
    emitLoginState(attempt, {
      phase: 'error',
      message:
        'The Claude CLI did not offer a sign-in link. Try `claude auth login` in a terminal.',
    })
    attempt.child.kill()
  }, URL_TIMEOUT_MS)
  attempt.flowTimer = setTimeout(() => onBrowserTimeout(attempt), BROWSER_TIMEOUT_MS)
  return attempt
}

export function emitLoginState(attempt: LoginAttempt, state: ClaudeLoginState): void {
  if (attempt.settled) return
  if (state.phase === 'signed-in' || state.phase === 'error' || state.phase === 'cancelled') {
    attempt.settled = true
    attempt.onSettled()
    clearTimeout(attempt.urlTimer)
    clearTimeout(attempt.flowTimer)
  }
  attempt.onState(state)
}

function readChunk(attempt: LoginAttempt, chunk: Buffer): void {
  attempt.output += chunk.toString()
  const url = parseClaudeLoginUrl(attempt.output)
  // A rejection returns to the browser step, not a terminal error.
  const invalid = hasInvalidCodeNotice(attempt.output)
  if (url && (url !== attempt.lastUrl || (invalid && attempt.awaitingExit))) {
    attempt.lastUrl = url
    attempt.awaitingExit = false
    clearTimeout(attempt.urlTimer)
    // The previous handshake is spent; the user begins a new browser trip.
    clearTimeout(attempt.flowTimer)
    attempt.flowTimer = setTimeout(() => onBrowserTimeout(attempt), BROWSER_TIMEOUT_MS)
    emitLoginState(attempt, { phase: 'awaiting-code', url, invalidCode: invalid })
  }
}

function onExit(attempt: LoginAttempt): void {
  if (attempt.settled) return
  // CLI prose is unreliable, and a rejected code may leave the old credential intact.
  void attempt
    .getStatus()
    .then((status) => {
      const stale =
        hasInvalidCodeNotice(attempt.output) && status.auth.email === attempt.emailBefore
      if (status.auth.loggedIn && !stale) {
        emitLoginState(attempt, { phase: 'signed-in', email: status.auth.email })
      } else emitLoginState(attempt, { phase: 'error', message: signOutMessage(attempt.output) })
    })
    .catch((error: unknown) =>
      emitLoginState(attempt, {
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
}

function onBrowserTimeout(attempt: LoginAttempt): void {
  emitLoginState(attempt, {
    phase: 'error',
    message:
      'Sign-in timed out waiting for your browser, so the Claude CLI was stopped. ' +
      'A code pasted now cannot be redeemed — start the sign-in again.',
  })
  attempt.child.kill()
}

export function submitLoginCode(attempt: LoginAttempt, code: string): void {
  attempt.awaitingExit = true
  emitLoginState(attempt, { phase: 'finishing' })
  attempt.child.stdin?.write(`${code.trim()}\n`)
}

export function cancelLoginAttempt(attempt: LoginAttempt): void {
  emitLoginState(attempt, { phase: 'cancelled' })
  attempt.child.kill()
}

/**
 * The last URL wins: a rejected code restarts OAuth with a new PKCE challenge.
 * Prefer the explicit fallback label, then accept a bare OAuth URL if prose changes.
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
