import { commandLifetime, controlContext, controlLog } from './cli-control'
import type { CliContext, CommandOf } from './cli-handlers'
import { runLogin } from './commands/login'
import { runLogout } from './commands/logout'
import { runService } from './commands/service'
import { runStatus, type StatusReport } from './commands/status'
import { serviceFact, showServiceFacts, showStatus, type ServiceFacts } from './ui/present-control'
import { enrollmentFlow, messageLines } from './ui/present-flow'
import type { Screen } from './ui/screen'

// login, status, logout and service, drawn for a person at a terminal. Each is
// attached to the shutdown exactly as its plain form in cli-control is.

/** status, login and logout: one control-plane request each. */
export async function screenControl(
  command: CommandOf<'login' | 'status' | 'logout'>,
  screen: Screen,
  context: CliContext,
): Promise<number> {
  const lifetime = commandLifetime(context, 'The control command could not finish.')
  const flow = enrollmentFlow(screen)
  const control = {
    ...controlContext(command.options, context, controlLog(context), lifetime.signal, flow.print),
    enrollment: flow.enrollment,
  }
  screen.open(`phosphor ${command.name}`, context.hostname)
  try {
    if (command.name === 'status') {
      const outcome = await screen.during('Asking Phosphor about this machine', () =>
        runStatus(control),
      )
      const confirmed = showStatus(screen, outcome.report, (control.now ?? Date.now)())
      if (confirmed) screen.close('Phosphor knows this machine.')
      else screen.close(`Not confirmed (exit ${outcome.exitCode}).`, 'warn')
      return outcome.exitCode
    }
    const local = command.name === 'logout' && command.options.local
    flow.working(
      command.name === 'login'
        ? 'Connecting to Phosphor'
        : local
          ? 'Forgetting this machine here'
          : 'Removing this machine from your account',
    )
    const outcome =
      command.name === 'login' ? await runLogin(control) : await runLogout(control, local)
    flow.settle()
    messageLines(screen).close(outcome.exitCode, outcome.message)
    return outcome.exitCode
  } finally {
    flow.settle()
    lifetime.end()
  }
}

const SERVICE_BUSY = {
  install: 'Installing and starting the service',
  status: 'Reading the service',
  restart: 'Restarting the service',
  uninstall: 'Stopping and removing the service',
} as const

/** The service's state as one line; its messages and the control status as they come. */
export async function screenService(
  command: CommandOf<'service'> & { action: keyof typeof SERVICE_BUSY },
  screen: Screen,
  context: CliContext,
): Promise<number> {
  const lifetime = commandLifetime(context, 'The service command could not finish.')
  const lines = messageLines(screen)
  // status prints its state lines first: they are collected and shown as one line.
  const facts: ServiceFacts = {}
  const print = (text: string) => serviceFact(facts, text) || lines.print(text)
  let known: boolean | null = null
  const status = (report: StatusReport) => {
    showServiceFacts(screen, facts)
    known = showStatus(screen, report, (context.control?.now ?? Date.now)())
  }
  const log = controlLog(context)
  const run = { ...controlContext(command.options, context, log, lifetime.signal, print), status }
  screen.open(`phosphor service ${command.action}`, context.hostname)
  try {
    const code = await screen.during(SERVICE_BUSY[command.action], () =>
      runService(run, command.action),
    )
    if (known === null) showServiceFacts(screen, facts)
    else lines.flush()
    const fallback = known === false ? 'Running, but not confirmed by Phosphor.' : 'Done.'
    lines.close(code, code === 0 ? fallback : `Failed (exit ${code}).`)
    return code
  } finally {
    lifetime.end()
  }
}
