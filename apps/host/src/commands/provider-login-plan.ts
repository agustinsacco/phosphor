import { EXIT } from '../checks'
import { claudeLoggedIn } from '../machine/claude'
import type { PiEnvironment } from '../machine/environment'
import { which, type PiLaunch } from '../machine/executables'
import { describeProvider, type ProviderState } from '../machine/providers'
import type { ProvidersOutcome } from './providers'

/** The Claude lane's login, beside pi's provider ids. */
export const CLAUDE_LOGIN = 'claude'

/** pi with no session, no project trust question and no extensions: a login and nothing else. */
export const PI_LOGIN_ARGS = ['--no-session', '--no-approve', '--no-extensions']

interface LoginProgram {
  file: string
  args: string[]
  host: string
  /** A successful status afterwards may still describe this earlier login. */
  before: boolean
}

export type ProviderLoginPlan = LoginProgram &
  ({ kind: 'claude' } | { kind: 'native'; row: ProviderState })

type LoginProblem = { exitCode: number; problem: string }

export async function prepareProviderLogin(
  provider: string,
  providers: ProviderState[],
  pi: { launch: PiLaunch; environment: PiEnvironment },
  options: { host: string; timeoutMs?: number },
): Promise<ProviderLoginPlan | LoginProblem> {
  const row = providers.find((candidate) => candidate.id === provider)
  if (provider === CLAUDE_LOGIN) {
    const file = await which('claude', pi.environment.env.PATH ?? '')
    if (!file) {
      return {
        exitCode: EXIT.unavailable,
        problem: 'Claude Code is not installed: run phosphor setup',
      }
    }
    const status = await claudeLoggedIn(file, pi.environment, { timeoutMs: options.timeoutMs })
    return {
      kind: 'claude',
      file,
      args: ['auth', 'login'],
      host: options.host,
      before: 'loggedIn' in status && status.loggedIn,
    }
  }
  if (!row) {
    const ids = [...providers.map((candidate) => candidate.id), CLAUDE_LOGIN].join(', ')
    return { exitCode: EXIT.usage, problem: `unknown provider "${provider}": one of ${ids}` }
  }
  return {
    kind: 'native',
    row,
    file: pi.launch.binaryPath,
    args: [...pi.launch.prefixArgs, ...PI_LOGIN_ARGS],
    host: options.host,
    before: row.status === 'ready',
  }
}

export function providerLoginInstructions(plan: ProviderLoginPlan): string[] {
  if (plan.kind === 'claude') {
    return [
      ...(plan.before
        ? ['Claude Code is already logged in here; logging in again replaces that login.']
        : []),
      `Signing in to Claude Code on ${plan.host}. claude auth login runs next:`,
      '  1. open the link it prints, on any computer, and sign in',
      '  2. paste the code the page shows here, and press Enter',
    ]
  }
  return [
    ...(plan.before
      ? [`${plan.row.name} is already signed in here; signing in again replaces that login.`]
      : []),
    `Signing in to ${plan.row.name} on ${plan.host}. pi opens next:`,
    `  1. type /login ${plan.row.id} and press Enter (twice if pi first completes the name);` +
      ' if pi asks how, choose to sign in with an account',
    '  2. open the link pi prints, on any computer, and sign in',
    '  3. if pi asks for a code, or the browser ends on an address that does not load, paste it into pi',
    '  4. once pi says you are logged in, type /quit',
  ]
}

export async function providerLoginStatus(
  plan: ProviderLoginPlan,
  after: ProvidersOutcome,
  environment: PiEnvironment,
  timeoutMs?: number,
): Promise<{ signedIn: boolean; message: string }> {
  if (plan.kind === 'claude') {
    const auth = await claudeLoggedIn(plan.file, environment, { timeoutMs })
    const signedIn = 'loggedIn' in auth && auth.loggedIn
    const state =
      'unreadable' in auth
        ? `claude auth status was unreadable${auth.unreadable}`
        : auth.loggedIn
          ? 'logged in'
          : 'not logged in'
    return { signedIn, message: statusMessage(plan, 'Claude Code', state, signedIn) }
  }
  const now =
    'report' in after ? after.report.providers.find((p) => p.id === plan.row.id) : undefined
  const signedIn = now?.status === 'ready'
  const state = now ? describeProvider(now) : 'unknown'
  return { signedIn, message: statusMessage(plan, plan.row.name, state, signedIn) }
}

function statusMessage(
  plan: ProviderLoginPlan,
  name: string,
  state: string,
  signedIn: boolean,
): string {
  const note =
    signedIn && plan.before
      ? ' It already was, so if the login did not finish, this is the earlier one.'
      : ''
  return `${name} on ${plan.host}: ${state}.${note}`
}
