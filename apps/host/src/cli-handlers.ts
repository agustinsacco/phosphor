import { HOST_PROTOCOL_VERSION } from '@phosphor/shared/remote-host'
import { EXIT } from './checks'
import type { CliOptions, ValidatedCommand } from './cli-args'
import { renderAccept, runAccept } from './commands/accept'
import { renderDoctor, runDoctor, type DoctorContext } from './commands/doctor'
import { runProviderLogin, type LoginContext } from './commands/provider-login'
import { renderProviders, runProviders } from './commands/providers'
import type { RunContext } from './commands/run'
import type { ServiceContext } from './commands/service'
import { runTailscale } from './commands/tailscale'
import { runUninstall } from './commands/uninstall'
import { runUpdate, type UpdateContext } from './commands/update'
import { handOffFromHost } from './update/handoff'
import { defaultConfigPath } from './config/load'
import type { ControlContext } from './control/command'
import { installHostPath } from './machine/shell-path'
import type { Drainable } from './shutdown'
import { HOST_SOURCE_SHA, HOST_VERSION } from './version'

/** stdout carries only the report or JSON; everything else goes to stderr. */
export interface CliIo {
  stdout(text: string): void
  stderr(text: string): void
}

export type CliContext = Omit<DoctorContext, 'configPath'> & {
  /** Setup resolves relative paths from the caller's working directory. */
  cwd?: string
  /** Drain a running Host on a signal or a fatal error, until the returned function detaches it. */
  attach?: (target: Drainable) => () => void
  /** stdin and stdout are a terminal, which a login needs. */
  terminal?: boolean
  /** Replaced in tests: hands the terminal to a login. */
  runInTerminal?: LoginContext['run']
  /** Control-plane I/O replaced in tests. */
  heartbeat?: RunContext['heartbeat']
  service?: ServiceContext['service']
  update?: UpdateContext['update']
  control?: Pick<ControlContext, 'fetch' | 'now' | 'random' | 'signal' | 'wait' | 'store' | 'arch'>
}

export type CommandOf<N extends ValidatedCommand['name']> = Extract<ValidatedCommand, { name: N }>

/** Runs one validated command and returns its exit code; a throw is an internal error. */
export type CommandHandler<C extends ValidatedCommand> = (
  command: C,
  io: CliIo,
  context: CliContext,
) => Promise<number>

/** --config wins, then the XDG location. */
export function configPathOf(options: CliOptions, context: CliContext): string {
  return options.config ?? defaultConfigPath(context.env, context.home)
}

const indented = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** The most lines an update or uninstall reports. */
const INSTALL_MESSAGES = 256

export async function handleVersion(
  command: CommandOf<'version'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const version = {
    hostVersion: HOST_VERSION,
    protocolVersion: HOST_PROTOCOL_VERSION,
    sourceSha: HOST_SOURCE_SHA,
    node: context.nodeVersion,
  }
  io.stdout(command.options.json ? `${JSON.stringify(version)}\n` : `phosphor ${HOST_VERSION}\n`)
  return EXIT.ok
}

export async function handleInstallPath(
  _command: CommandOf<'internal-install-path'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  installHostPath({ ...context, print: (line) => io.stdout(`${line}\n`) })
  return EXIT.ok
}

export async function handleTailscale(
  command: CommandOf<'tailscale'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const configPath = configPathOf(command.options, context)
  const outcome = await runTailscale({ ...context, configPath }, command.action, context.tailscale)
  io.stdout(`${outcome.message}\n`)
  return outcome.exitCode
}

/** update and uninstall: their messages are collected, then printed as lines or one JSON. */
export async function handleInstall(
  command: CommandOf<'update' | 'uninstall'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const { options } = command
  const messages: string[] = []
  const install = {
    ...context,
    json: options.json,
    ...context.control,
    configPath: configPathOf(options, context),
    print: (line: string) => {
      if (messages.length < INSTALL_MESSAGES) messages.push(line)
    },
  }
  const exitCode =
    command.name === 'update'
      ? ((await handOffFromHost(install, options)) ?? (await runUpdate(install, options)))
      : await runUninstall(install, options.purge, options.yes)
  io.stdout(
    options.json ? `${JSON.stringify({ exitCode, messages })}\n` : messages.join('\n') + '\n',
  )
  return exitCode
}

export async function handleDoctor(
  command: CommandOf<'doctor'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const report = await runDoctor({ ...context, configPath: configPathOf(command.options, context) })
  io.stdout(command.options.json ? indented(report) : renderDoctor(report))
  return report.exitCode
}

/** The providers report, or doctor's when pi could not be asked. */
export async function handleProviders(
  command: CommandOf<'providers'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const { json } = command.options
  const outcome = await runProviders({
    ...context,
    configPath: configPathOf(command.options, context),
  })
  if ('problem' in outcome) {
    io.stderr(`phosphor: ${outcome.problem}\n`)
    const { doctor } = outcome
    io.stdout(json ? indented(doctor) : renderDoctor(doctor))
    return outcome.exitCode
  }
  const { report } = outcome
  io.stdout(json ? indented(report) : renderProviders(report))
  return report.exitCode
}

/** Steps on stderr while the login has the terminal; the providers report after it. */
export async function handleProviderLogin(
  command: CommandOf<'providers login'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const outcome = await runProviderLogin({
    ...context,
    configPath: configPathOf(command.options, context),
    provider: command.provider,
    progress: (line) => io.stderr(`${line}\n`),
    run: context.runInTerminal,
  })
  const shown = 'problem' in outcome ? outcome : outcome.after
  if ('problem' in shown) {
    io.stderr(`phosphor: ${shown.problem}\n`)
    if (shown.doctor) io.stdout(renderDoctor(shown.doctor))
  } else {
    io.stdout(renderProviders(shown.report))
  }
  return outcome.exitCode
}

/** Progress on stderr; the evidence, or doctor's report when the lanes could not run, on stdout. */
export async function handleAccept(
  command: CommandOf<'accept'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const { options } = command
  const outcome = await runAccept({
    ...context,
    configPath: configPathOf(options, context),
    repository: command.repository,
    lane: command.lane,
    keepTranscripts: options['keep-transcripts'] ?? false,
    provider: options.provider,
    claudeModel: options['claude-model'],
    model: options.model,
    progress: (line) => io.stderr(`${line}\n`),
  })
  if ('problem' in outcome) {
    io.stderr(`phosphor: ${outcome.problem}\n`)
    const { doctor } = outcome
    if (doctor) io.stdout(options.json ? indented(doctor) : renderDoctor(doctor))
  } else {
    const { evidence } = outcome
    io.stdout(options.json ? indented(evidence) : renderAccept(evidence))
  }
  return outcome.exitCode
}
