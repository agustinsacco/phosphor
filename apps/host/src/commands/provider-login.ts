import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXIT } from '../checks'
import { claudeLoggedIn } from '../machine/claude'
import { which } from '../machine/executables'
import { describeProvider } from '../machine/providers'
import type { Drainable } from '../shutdown'
import { runInTerminal, type TerminalRun } from '../machine/terminal'
import { inspectHost, type DoctorContext, type DoctorReport } from './doctor'
import { runProviders, type ProvidersOutcome } from './providers'

/** The Claude lane's login, beside pi's provider ids. */
export const CLAUDE_LOGIN = 'claude'

/** pi with no session, no project trust question and no extensions: a login and nothing else. */
export const PI_LOGIN_ARGS = ['--no-session', '--no-approve', '--no-extensions']

export interface LoginContext extends DoctorContext {
  provider: string
  /** Drain the program on the terminal on a signal, until the returned function detaches it. */
  attach?: (target: Drainable) => () => void
  /** Steps and outcomes, for the person at the terminal: stderr. */
  progress: (line: string) => void
  /** Replaced in tests: hands the terminal to a program until it exits. */
  run?: typeof runInTerminal
}

export type LoginOutcome =
  /** The login ran: the providers report after it, and whether the provider is now signed in. */
  | { exitCode: number; after: ProvidersOutcome }
  /** Nothing ran. */
  | { exitCode: number; problem: string; doctor?: DoctorReport }

/**
 * Sign in to one provider on this Host, in this terminal, with the provider's
 * own login: pi's `/login` for a pi provider, `claude auth login` for the
 * Claude lane. The credential is made by pi or claude and stays in their
 * stores; the Host never sees it. Then it shows `phosphor providers` again.
 * Exits 0 once the provider is signed in, 69 when it is not.
 */
export async function runProviderLogin(context: LoginContext): Promise<LoginOutcome> {
  const { report, pi } = await inspectHost(context)
  if (!pi || !report.providers) {
    const problem = 'pi is not usable here, so nothing can sign in through it'
    return { exitCode: report.exitCode, problem, doctor: report }
  }
  const { provider, progress } = context
  const host = report.config.hostId ?? 'this machine'
  const isClaude = provider === CLAUDE_LOGIN
  const row = report.providers.find((candidate) => candidate.id === provider)
  if (!isClaude && !row) {
    const ids = [...report.providers.map((candidate) => candidate.id), CLAUDE_LOGIN].join(', ')
    return { exitCode: EXIT.usage, problem: `unknown provider "${provider}": one of ${ids}` }
  }
  const { env } = pi.environment
  // The login draws a screen: it needs the terminal's type, which sessions never get.
  const terminalEnv = context.env.TERM ? { ...env, TERM: context.env.TERM } : env
  let file: string
  let args: string[]
  // Signed in before the login: afterwards, "signed in" may be that login still.
  let before: boolean
  if (isClaude) {
    const claude = await which('claude', env.PATH ?? '')
    if (!claude) {
      const problem = 'Claude Code is not installed: run phosphor setup'
      return { exitCode: EXIT.unavailable, problem }
    }
    file = claude
    args = ['auth', 'login']
    const status = await claudeLoggedIn(claude, pi.environment, {
      timeoutMs: context.probeTimeoutMs,
    })
    before = 'loggedIn' in status && status.loggedIn
    if (before) {
      progress('Claude Code is already logged in here; logging in again replaces that login.')
    }
    progress(`Signing in to Claude Code on ${host}. claude auth login runs next:`)
    progress('  1. open the link it prints, on any computer, and sign in')
    progress('  2. paste the code the page shows here, and press Enter')
  } else {
    file = pi.launch.binaryPath
    args = [...pi.launch.prefixArgs, ...PI_LOGIN_ARGS]
    before = row!.status === 'ready'
    if (before) {
      progress(`${row!.name} is already signed in here; signing in again replaces that login.`)
    }
    progress(`Signing in to ${row!.name} on ${host}. pi opens next:`)
    progress(
      `  1. type /login ${provider} and press Enter (twice if pi first completes the name);` +
        ' if pi asks how, choose to sign in with an account',
    )
    progress('  2. open the link pi prints, on any computer, and sign in')
    progress(
      '  3. if pi asks for a code, or the browser ends on an address that does not load, paste it into pi',
    )
    progress('  4. once pi says you are logged in, type /quit')
  }

  // An empty folder: no project settings, no context files, no trust question.
  const cwd = mkdtempSync(join(tmpdir(), 'phosphor-login-'))
  let ran: TerminalRun
  try {
    ran = await (context.run ?? runInTerminal)(file, args, {
      cwd,
      env: terminalEnv,
      attach: context.attach,
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
  if (ran.error) {
    return { exitCode: EXIT.unavailable, problem: `${file} could not start: ${ran.error}` }
  }

  const after = await runProviders(context)
  const note = (signedIn: boolean) =>
    signedIn && before
      ? ' It already was, so if the login did not finish, this is the earlier one.'
      : ''
  let signedIn: boolean
  let state: string
  if (isClaude) {
    const auth = await claudeLoggedIn(file, pi.environment, { timeoutMs: context.probeTimeoutMs })
    signedIn = 'loggedIn' in auth && auth.loggedIn
    state =
      'unreadable' in auth
        ? `claude auth status was unreadable${auth.unreadable}`
        : auth.loggedIn
          ? 'logged in'
          : 'not logged in'
    progress(`Claude Code on ${host}: ${state}.${note(signedIn)}`)
  } else {
    const now =
      'report' in after ? after.report.providers.find((p) => p.id === provider) : undefined
    signedIn = now?.status === 'ready'
    state = now ? describeProvider(now) : 'unknown'
    progress(`${row!.name} on ${host}: ${state}.${note(signedIn)}`)
  }
  return { exitCode: signedIn ? EXIT.ok : EXIT.unavailable, after }
}
