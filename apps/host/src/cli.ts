import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { errorText } from '@phosphor/shared/errors'
import { HOST_PROTOCOL_VERSION } from '@phosphor/shared/remote-host'
import { EXIT } from './checks'
import { renderAccept, runAccept, type AcceptLane } from './commands/accept'
import { renderDoctor, runDoctor, type DoctorContext } from './commands/doctor'
import { defaultConfigPath } from './config/load'
import type { Drainable } from './shutdown'
import { HOST_SOURCE_SHA, HOST_VERSION } from './version'

export const USAGE = `usage: phosphor <command>

  doctor [--config FILE] [--json]   check that this machine can run a Host
  accept --repository DIR [--lane native|claude|all] [--keep-transcripts]
         [--provider NAME] [--model ID] [--config FILE] [--json]
                                    run real sessions in DIR, an empty repository
                                    from the config, and report what they proved;
                                    --provider and --model choose what the native
                                    lane runs on
  version [--json]                  print the Host's version

exit codes: 0 ok, 1 an acceptance check failed, 64 usage, 69 prerequisite unavailable,
70 internal error, 78 config invalid, 128+n ended by signal n
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
  accept: ['config', 'json', 'repository', 'lane', 'keep-transcripts', 'provider', 'model'],
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
  const lane = values.lane ?? 'all'
  if (!['native', 'claude', 'all'].includes(lane)) return usage('--lane is native, claude or all')
  if (command === 'accept' && !values.repository) return usage('accept needs --repository DIR')
  if (values.repository !== undefined && !isAbsolute(values.repository)) {
    return usage('--repository needs an absolute path')
  }

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
    if (command === 'accept') {
      const outcome = await runAccept({
        ...context,
        configPath,
        repository: values.repository!,
        lane: lane as AcceptLane | 'all',
        keepTranscripts: values['keep-transcripts'] ?? false,
        provider: values.provider,
        model: values.model,
        progress: (line) => io.stderr(`${line}\n`),
      })
      if ('problem' in outcome) {
        io.stderr(`phosphor: ${outcome.problem}\n`)
        const { doctor } = outcome
        if (doctor) {
          io.stdout(values.json ? `${JSON.stringify(doctor, null, 2)}\n` : renderDoctor(doctor))
        }
      } else {
        const { evidence } = outcome
        io.stdout(values.json ? `${JSON.stringify(evidence, null, 2)}\n` : renderAccept(evidence))
      }
      return outcome.exitCode
    }
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
      repository: { type: 'string' },
      lane: { type: 'string' },
      'keep-transcripts': { type: 'boolean' },
      provider: { type: 'string' },
      model: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
}
