import type { CliOptions } from './cli-args'
import { configPathOf, type CliContext, type CliIo, type CommandOf } from './cli-handlers'
import { runHost } from './commands/run'
import { runService } from './commands/service'
import { runLogin } from './commands/login'
import { runLogout } from './commands/logout'
import { renderStatus, runStatus } from './commands/status'
import { createHostLog, hostLogDirectory, type HostLog } from './machine/log'
import { screenControl, screenService } from './cli-screens-control'
import { screenFor } from './ui/screen'

/** A command's abort signal, and the call that marks the command ended. */
export interface CommandLifetime {
  signal: AbortSignal
  /** Settles a pending drain and detaches from the shutdown. Call once, when the command ends. */
  end(): void
}

/**
 * The command's own abort signal, also aborted by the control port's. Given
 * the text a failed drain shows, the command attaches to the shutdown: a drain
 * aborts it and waits for end(). Without it nothing attaches, which is how
 * `run` leaves the one attachment to runHost.
 */
export function commandLifetime(context: CliContext, drainFailure?: string): CommandLifetime {
  const controller = new AbortController()
  let finished = () => {}
  const ended = new Promise<void>((resolve) => {
    finished = resolve
  })
  const detach =
    drainFailure === undefined
      ? undefined
      : context.attach?.({
          drain: async () => {
            controller.abort()
            await ended
            return { state: 'stopped' }
          },
          log: { write: () => {}, hide: () => drainFailure },
        })
  const signal = context.control?.signal
    ? AbortSignal.any([controller.signal, context.control.signal])
    : controller.signal
  return {
    signal,
    end: () => {
      finished()
      detach?.()
    },
  }
}

/** The Host log for control commands, hiding every environment value of 8 or more characters. */
export function controlLog(context: Pick<CliContext, 'env' | 'home'>): HostLog {
  return createHostLog(
    hostLogDirectory(context.env, context.home),
    Object.values(context.env).filter(
      (value): value is string => typeof value === 'string' && value.length >= 8,
    ),
  )
}

/** What run, service and the control commands share: ports, log, config, signal and printer. */
export function controlContext(
  options: CliOptions,
  context: CliContext,
  log: HostLog,
  signal: AbortSignal,
  print: (line: string) => void,
) {
  return {
    ...context,
    ...context.control,
    log: log.write,
    configPath: configPathOf(options, context),
    signal,
    print,
  }
}

/** A line printed whole, whether or not it already ends in a newline. */
const printLine = (io: CliIo) => (line: string) =>
  io.stdout(line.endsWith('\n') ? line : `${line}\n`)

/** runHost attaches itself to the shutdown, so the CLI adds no attachment of its own. */
export async function handleRun(
  command: CommandOf<'run'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const log = controlLog(context)
  const lifetime = commandLifetime(context)
  const run = controlContext(command.options, context, log, lifetime.signal, printLine(io))
  try {
    return await runHost({ ...run, supervisor: command.supervisor })
  } finally {
    lifetime.end()
  }
}

export async function handleService(
  command: CommandOf<'service'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  // logs streams journalctl as it is; the other actions draw a screen.
  const { action } = command
  const screen = screenFor(context.rich)
  if (screen && action !== 'logs') return screenService({ ...command, action }, screen, context)
  const log = controlLog(context)
  const lifetime = commandLifetime(context, 'The service command could not finish.')
  const run = controlContext(command.options, context, log, lifetime.signal, printLine(io))
  try {
    return await runService(run, command.action, command.options.follow)
  } finally {
    lifetime.end()
  }
}

/** login, status and logout: one control-plane request each, attached to the shutdown. */
export async function handleControl(
  command: CommandOf<'login' | 'status' | 'logout'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const screen = screenFor(context.rich, command.options.json)
  if (screen) return screenControl(command, screen, context)
  const log = controlLog(context)
  const lifetime = commandLifetime(context, 'The control command could not finish.')
  const print = (line: string) => io.stdout(`${line}\n`)
  const control = controlContext(command.options, context, log, lifetime.signal, print)
  try {
    if (command.name === 'status') {
      const outcome = await runStatus(control)
      const { report } = outcome
      io.stdout(command.options.json ? `${JSON.stringify(report)}\n` : renderStatus(report))
      return outcome.exitCode
    }
    const outcome =
      command.name === 'login'
        ? await runLogin(control)
        : await runLogout(control, command.options.local)
    io.stdout(`${outcome.message}\n`)
    return outcome.exitCode
  } finally {
    lifetime.end()
  }
}
