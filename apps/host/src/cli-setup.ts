import { EXIT } from './checks'
import { commandLifetime } from './cli-control'
import { configPathOf, type CliContext, type CliIo, type CommandOf } from './cli-handlers'
import { runGuidedSetup } from './commands/guided-setup'
import { renderSetup, runSetup, type SetupReport } from './commands/setup'
import { createIdentityStore, identityDirectory } from './control/identity'

/** On a terminal setup is guided to the end; otherwise it only writes the config. */
export function handleSetup(
  command: CommandOf<'setup'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  return context.terminal
    ? guidedSetup(command, io, context)
    : configOnlySetup(command, io, context)
}

/** Older SSH clients without a terminal: never enrolls, starts the service or asks Tailscale. */
async function configOnlySetup(
  command: CommandOf<'setup'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const { options } = command
  const configPath = configPathOf(options, context)
  const report = await runSetup({
    ...context,
    cwd: context.cwd ?? process.cwd(),
    configPath,
    repositories: command.repositories,
    pi: options.pi,
    node: options.node,
    replace: options.replace,
    tailscaleHints: false,
  })
  // Point at login only when this machine is not on an account yet.
  const enrolled = await createIdentityStore(identityDirectory(configPath), process.getuid?.())
    .load()
    .then((loaded) => loaded !== null)
    .catch(() => false)
  if (report.exitCode === EXIT.ok && !enrolled) report.next = 'phosphor login'
  io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderSetup(report))
  return report.exitCode
}

/** Attached to the shutdown; with --json the steps go to stderr and the report alone to stdout. */
async function guidedSetup(
  command: CommandOf<'setup'>,
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const { options } = command
  const lifetime = commandLifetime(context, 'Setup could not finish.')
  let report: SetupReport
  try {
    report = await runGuidedSetup({
      ...context,
      json: options.json,
      ...context.control,
      cwd: context.cwd ?? process.cwd(),
      configPath: configPathOf(options, context),
      repositories: command.repositories,
      pi: options.pi,
      node: options.node,
      replace: options.replace,
      signal: lifetime.signal,
      print: (line) => (options.json ? io.stderr : io.stdout)(`${line}\n`),
    })
  } finally {
    lifetime.end()
  }
  if (options.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`)
  return report.exitCode
}
