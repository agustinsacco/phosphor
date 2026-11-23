import { errorText } from '@phosphor/shared/errors'
import { EXIT } from './checks'
import {
  isCommandName,
  readCliRequest,
  scanArgv,
  supervisedRun,
  type ValidatedCommand,
} from './cli-args'
import { runCliOps } from './cli-ops'
import { handleControl, handleRun, handleService } from './cli-control'
import {
  handleAccept,
  handleDoctor,
  handleInstall,
  handleInstallPath,
  handleProviderLogin,
  handleProviders,
  handleTailscale,
  handleVersion,
  type CliContext,
  type CliIo,
  type CommandHandler,
  type CommandOf,
} from './cli-handlers'
import { handleSetup } from './cli-setup'
import { refuseUsage, USAGE } from './cli-usage'

export { CLI_PARSE_CONFIG, supervisedRun } from './cli-args'
export type { CliContext, CliIo } from './cli-handlers'
export { USAGE } from './cli-usage'

type CommandName = ValidatedCommand['name']

/** One handler per validated command: a name without one does not compile. */
const COMMANDS: { [N in CommandName]: CommandHandler<CommandOf<N>> } = {
  version: handleVersion,
  'internal-install-path': handleInstallPath,
  doctor: handleDoctor,
  providers: handleProviders,
  'providers login': handleProviderLogin,
  accept: handleAccept,
  tailscale: handleTailscale,
  update: handleInstall,
  uninstall: handleInstall,
  setup: handleSetup,
  run: handleRun,
  service: handleService,
  login: handleControl,
  status: handleControl,
  logout: handleControl,
}

function dispatch<N extends CommandName>(
  name: N,
  command: CommandOf<N>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  return COMMANDS[name](command, io, context)
}

/**
 * Known commands first. Only argv whose first word the command table does not
 * know, and is not `help`, goes to the catalog ops CLI.
 */
export function runCli(argv: readonly string[], io: CliIo, context: CliContext): Promise<number> {
  const { command } = scanArgv(argv)
  return command !== undefined && command !== 'help' && !isCommandName(command)
    ? runCliOps(argv, io, context, runCommandTable)
    : runCommandTable(argv, io, context)
}

async function runCommandTable(
  argv: readonly string[],
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const supervised = supervisedRun(argv)
  const request = readCliRequest(argv, context.terminal)
  if (request.kind === 'help') {
    io.stdout(USAGE)
    return EXIT.ok
  }
  if (request.kind === 'usage') {
    return refuseUsage(request.problem, {
      stderr: io.stderr,
      supervised,
      env: context.env,
      home: context.home,
      now: () => context.control?.now?.() ?? Date.now(),
    })
  }
  try {
    return await dispatch(request.command.name, request.command, io, context)
  } catch (error) {
    io.stderr(`phosphor: internal error: ${errorText(error)}\n`)
    return EXIT.internal
  }
}
