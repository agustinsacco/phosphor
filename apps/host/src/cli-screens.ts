import { configPathOf, type CliContext, type CommandOf } from './cli-handlers'
import { runAccept } from './commands/accept'
import { runDoctor } from './commands/doctor'
import { runProviderLogin } from './commands/provider-login'
import { runProviders } from './commands/providers'
import { runTailscale } from './commands/tailscale'
import { runUninstall } from './commands/uninstall'
import { SetupCancelled } from './commands/setup-terminal'
import { runUpdate } from './commands/update'
import { runInTerminal } from './machine/terminal'
import { handOffFromHost } from './update/handoff'
import { lineTone, messageLines, updateProgress } from './ui/present-flow'
import { acceptProgress, showAccept, showDoctor, showProviders } from './ui/present-reports'
import type { Screen } from './ui/screen'

// The same commands as cli-handlers, drawn for a person at a terminal: each
// opens with its name, spins while it works and closes with what it found.

export async function screenDoctor(
  command: CommandOf<'doctor'>,
  screen: Screen,
  context: CliContext,
): Promise<number> {
  screen.open('phosphor doctor', context.hostname)
  const configPath = configPathOf(command.options, context)
  const report = await screen.during('Checking this machine', () =>
    runDoctor({ ...context, configPath }),
  )
  showDoctor(screen, report, context.home)
  return report.exitCode
}

export async function screenProviders(
  command: CommandOf<'providers'>,
  screen: Screen,
  context: CliContext,
): Promise<number> {
  screen.open('phosphor providers', context.hostname)
  const configPath = configPathOf(command.options, context)
  const outcome = await screen.during('Asking pi what it can sign into', () =>
    runProviders({ ...context, configPath }),
  )
  if ('problem' in outcome) {
    screen.say(outcome.problem, 'fail')
    showDoctor(screen, outcome.doctor, context.home)
    return outcome.exitCode
  }
  showProviders(screen, outcome.report, context.home)
  return outcome.report.exitCode
}

/** The steps as a note just before the login takes the terminal, then the providers after it. */
export async function screenProviderLogin(
  command: CommandOf<'providers login'>,
  screen: Screen,
  context: CliContext,
): Promise<number> {
  screen.open(`Sign in to ${command.provider}`, context.hostname)
  const steps: string[] = []
  let busy = screen.busy('Checking pi')
  let handedOver = false
  const outcome = await runProviderLogin({
    ...context,
    configPath: configPathOf(command.options, context),
    provider: command.provider,
    progress: (line) => (handedOver ? busy.done(line, lineTone(line)) : steps.push(line)),
    run: (file, args, options) => {
      busy.clear()
      const [title = 'Next', ...rest] = steps
      screen.note(rest.join('\n'), title)
      screen.handOver()
      handedOver = true
      return (context.runInTerminal ?? runInTerminal)(file, args, options).finally(() => {
        busy = screen.busy('Checking the sign-in')
      })
    },
  }).finally(() => busy.clear())
  const shown = 'problem' in outcome ? outcome : outcome.after
  if ('problem' in shown) {
    screen.say(shown.problem, 'fail')
    if (shown.doctor) showDoctor(screen, shown.doctor, context.home)
    else screen.close(`Not signed in (exit ${outcome.exitCode}).`, 'fail')
  } else showProviders(screen, shown.report, context.home)
  return outcome.exitCode
}

/** Each step as it passes, under a spinner, then the lanes' verdicts. */
export async function screenAccept(
  command: CommandOf<'accept'>,
  screen: Screen,
  context: CliContext,
): Promise<number> {
  const { options } = command
  screen.open('phosphor accept', command.repository)
  const outcome = await screen.during('Running real sessions', () =>
    runAccept({
      ...context,
      configPath: configPathOf(options, context),
      repository: command.repository,
      lane: command.lane,
      keepTranscripts: options['keep-transcripts'] ?? false,
      provider: options.provider,
      claudeModel: options['claude-model'],
      model: options.model,
      progress: (line) => {
        const { tone, text } = acceptProgress(line)
        screen.say(text, tone)
      },
    }),
  )
  if ('problem' in outcome) {
    screen.say(outcome.problem, 'fail')
    if (outcome.doctor) showDoctor(screen, outcome.doctor, context.home)
    else screen.close(`Not accepted (exit ${outcome.exitCode}).`, 'fail')
  } else showAccept(screen, outcome.evidence, context.home, false)
  return outcome.exitCode
}

export async function screenTailscale(
  command: CommandOf<'tailscale'>,
  screen: Screen,
  context: CliContext,
): Promise<number> {
  screen.open(`phosphor tailscale ${command.action}`, context.hostname)
  const configPath = configPathOf(command.options, context)
  const outcome = await screen.during(TAILSCALE_BUSY[command.action], () =>
    runTailscale({ ...context, configPath }, command.action, context.tailscale),
  )
  messageLines(screen).close(outcome.exitCode, outcome.message)
  return outcome.exitCode
}

const TAILSCALE_BUSY = {
  status: 'Reading the tailnet address',
  enable: 'Publishing the Host on your tailnet',
  disable: 'Removing the Host from your tailnet',
} as const

/** update's steps as spinners; uninstall asks first, since it removes the program. */
export async function screenInstall(
  command: CommandOf<'update' | 'uninstall'>,
  screen: Screen,
  context: CliContext,
): Promise<number> {
  const { options } = command
  screen.open(`phosphor ${command.name}`, context.hostname)
  const lines = messageLines(screen)
  const install = {
    ...context,
    ...context.control,
    configPath: configPathOf(options, context),
    print: lines.print,
    progress: updateProgress(screen),
    screen,
  }
  let exitCode: number
  if (command.name === 'update') {
    exitCode =
      (await handOffFromHost(install, options)) ?? (await runUpdate(install, command.options))
  } else {
    // --purge always comes with --yes (the parser refuses one without the other), so only a
    // plain uninstall, which keeps the config and identity, is ever asked about.
    const yes = command.options.yes || (await askUninstall(screen))
    if (yes !== true) {
      screen.close(yes ? 'Cancelled. Nothing was uninstalled.' : 'Nothing was uninstalled.')
      return yes ? 130 : 0
    }
    exitCode = await runUninstall(install, command.options.purge, command.options.yes)
  }
  lines.close(exitCode, exitCode === 0 ? 'Done.' : `Failed (exit ${exitCode}).`)
  return exitCode
}

/** true to go ahead, false when declined, 'cancelled' for Ctrl-C or Escape. */
function askUninstall(screen: Screen): Promise<boolean | 'cancelled'> {
  const question = 'Uninstall the Host program and its service? Your config and identity stay.'
  return screen.ask(question).catch((error: unknown) => {
    if (error instanceof SetupCancelled) return 'cancelled' as const
    throw error
  })
}
