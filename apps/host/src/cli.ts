import { parseArgs } from 'node:util'
import { errorText } from '@phosphor/shared/errors'
import { HOST_PROTOCOL_VERSION } from '@phosphor/shared/remote-host'
import { EXIT } from './checks'
import { renderDoctor, runDoctor, type DoctorContext } from './commands/doctor'
import { defaultConfigPath } from './config/load'
import type { Drainable } from './shutdown'
import { HOST_SOURCE_SHA, HOST_VERSION } from './version'

export const USAGE = `usage: phosphor <command>

  doctor [--config FILE] [--json]   check that this machine can run a Host
  version [--json]                  print the Host's version

exit codes: 0 ok, 64 usage, 69 prerequisite unavailable, 70 internal error, 78 config invalid
`

/** stdout carries only the report or JSON; everything else goes to stderr. */
export interface CliIo {
  stdout(text: string): void
  stderr(text: string): void
}

export type CliContext = Omit<DoctorContext, 'configPath'> & {
  /** Drain a running Host on a signal or a fatal error, until the returned function detaches it. */
  attach?: (target: Drainable) => () => void
}

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  doctor: ['config', 'json'],
  version: ['json'],
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const usage = (problem: string) => {
    io.stderr(`phosphor: ${problem}\n\n${USAGE}`)
    return EXIT.usage
  }
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch (error) {
    return usage(errorText(error))
  }
  const { values, positionals } = parsed
  const [command, ...extra] = positionals
  if (values.help || command === 'help') {
    io.stdout(USAGE)
    return EXIT.ok
  }
  if (command === undefined) return usage('no command given')
  const allowed = COMMAND_OPTIONS[command]
  if (!allowed) return usage(`unknown command "${command}"`)
  if (extra.length > 0) return usage(`unexpected argument "${extra[0]}"`)
  const refused = Object.keys(values).find((option) => !allowed.includes(option))
  if (refused) return usage(`${command} does not take --${refused}`)
  if (values.config === '') return usage('--config needs a file')

  try {
    if (command === 'version') {
      const version = {
        hostVersion: HOST_VERSION,
        protocolVersion: HOST_PROTOCOL_VERSION,
        sourceSha: HOST_SOURCE_SHA,
        node: context.nodeVersion,
      }
      io.stdout(values.json ? `${JSON.stringify(version)}\n` : `phosphor ${HOST_VERSION}\n`)
      return EXIT.ok
    }
    const configPath = values.config ?? defaultConfigPath(context.env, context.home)
    const report = await runDoctor({ ...context, configPath })
    io.stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctor(report))
    return report.exitCode
  } catch (error) {
    io.stderr(`phosphor: internal error: ${errorText(error)}\n`)
    return EXIT.internal
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
}
