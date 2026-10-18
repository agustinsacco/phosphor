import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { ClaudeLoginState } from '@shared/models'
import { claudeStatus, resolveBinary } from './packages'
import { piProcessEnv } from './shell-env'
import {
  cancelLoginAttempt,
  createLoginAttempt,
  emitLoginState,
  submitLoginCode,
  type LoginAttempt,
} from './claude-login-attempt'

const execFileAsync = promisify(execFile)

/**
 * Signing the Claude Code CLI in and out from inside Phosphor.
 *
 * This is the account that bills a Claude Pro/Max plan (`pi-claude-cli`), and
 * until now Phosphor only *read* it — the tab told the user to go run `claude` in
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
 * - **The CLI opens the browser itself.** Phosphor must not open it too, or the
 *   user gets two tabs and pastes the code from the stale one. The UI offers
 *   the URL as a fallback link instead.
 * - **A wrong code is not fatal.** The CLI prints `Invalid code.` and re-prompts
 *   with a *fresh* URL, so the flow returns to `awaiting-code` rather than
 *   failing — and the newest URL is the live one.
 * - **Its prose is not the outcome.** A run given a bogus code still printed
 *   `Login successful.` and exited 0. Completion is therefore decided by
 *   `claude auth status`, the same fact the rest of Phosphor already trusts, never
 *   by matching output. (Same principle as `login-flow.ts`.)
 */

export { hasInvalidCodeNotice, parseClaudeLoginUrl } from './claude-login-attempt'

let running: LoginAttempt | null = null

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

  running = createLoginAttempt({
    child,
    emailBefore,
    onState,
    onSettled: () => {
      running = null
    },
    getStatus: () => claudeStatus(claudeOverride, extraEnv),
  })
  emitLoginState(running, { phase: 'starting' })
}

/** Hand the code the user copied from the browser to the waiting CLI. */
export function submitClaudeLoginCode(code: string): void {
  if (!running) throw new Error('No Claude sign-in is in progress.')
  submitLoginCode(running, code)
}

/** Stop a flow started by `startClaudeLogin`. Safe when nothing is running. */
export function cancelClaudeLogin(): void {
  if (running) cancelLoginAttempt(running)
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
