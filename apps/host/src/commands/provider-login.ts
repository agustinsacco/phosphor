import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXIT } from '../checks'
import type { Drainable } from '../shutdown'
import { runInTerminal, type TerminalRun } from '../machine/terminal'
import { inspectHost, type DoctorContext, type DoctorReport } from './doctor'
import { runProviders, type ProvidersOutcome } from './providers'
import {
  prepareProviderLogin,
  providerLoginInstructions,
  providerLoginStatus,
} from './provider-login-plan'

export { CLAUDE_LOGIN, PI_LOGIN_ARGS } from './provider-login-plan'

export interface LoginContext extends DoctorContext {
  provider: string
  /** Trusted Host account routing only. Never accepted from an API caller. */
  credentialEnv?: Record<string, string>
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
  const environment = {
    ...pi.environment,
    env: { ...pi.environment.env, ...context.credentialEnv },
  }
  const plan = await prepareProviderLogin(
    provider,
    report.providers,
    { ...pi, environment },
    {
      host: report.config.hostId ?? 'this machine',
      timeoutMs: context.probeTimeoutMs,
    },
  )
  if ('problem' in plan) return plan
  for (const line of providerLoginInstructions(plan)) progress(line)

  const { env } = environment
  // The login draws a screen: it needs the terminal's type, which sessions never get.
  const terminalEnv = context.env.TERM ? { ...env, TERM: context.env.TERM } : env
  // An empty folder: no project settings, no context files, no trust question.
  const cwd = mkdtempSync(join(tmpdir(), 'phosphor-login-'))
  let ran: TerminalRun
  try {
    ran = await (context.run ?? runInTerminal)(plan.file, plan.args, {
      cwd,
      env: terminalEnv,
      attach: context.attach,
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
  if (ran.error) {
    return { exitCode: EXIT.unavailable, problem: `${plan.file} could not start: ${ran.error}` }
  }

  const after = await runProviders(context)
  const { signedIn, message } = await providerLoginStatus(
    plan,
    after,
    environment,
    context.probeTimeoutMs,
  )
  progress(message)
  return { exitCode: signedIn ? EXIT.ok : EXIT.unavailable, after }
}
