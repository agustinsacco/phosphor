import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { errorText } from '@phosphor/shared/errors'
import { HOST_PROTOCOL_VERSION } from '@phosphor/shared/remote-host'
import { EXIT } from './checks'
import { renderAccept, runAccept, type AcceptLane } from './commands/accept'
import { renderDoctor, runDoctor, type DoctorContext } from './commands/doctor'
import type { LoginContext } from './commands/provider-login'
import { renderProviders, runProviders } from './commands/providers'
import { runProviderLogin } from './commands/provider-login'
import { runLogin } from './commands/login'
import { runLogout } from './commands/logout'
import { renderStatus, runStatus } from './commands/status'
import type { ControlContext } from './control/command'
import { defaultConfigPath } from './config/load'
import type { Drainable } from './shutdown'
import { HOST_SOURCE_SHA, HOST_VERSION } from './version'

export const USAGE = `usage: phosphor <command>

Set up a Host in three steps: doctor, then providers, then accept.

  doctor [--config FILE] [--json]   check that this machine can run a Host
  providers [--config FILE] [--json]
                                    show which providers pi can use here
  providers login PROVIDER [--config FILE]
                                    sign in to PROVIDER here, in this terminal, with
                                    its own login: a pi provider id, or claude for
                                    the claude lane
  accept --repository DIR [--lane native|claude|all] [--keep-transcripts]
         [--model ID [--provider NAME]] [--claude-model ID]
         [--config FILE] [--json]
                                    run real sessions in DIR, an empty repository
                                    from the config, and report what they proved;
                                    --provider and --model choose what the native
                                    lane runs on, --claude-model the Claude lane's
                                    model
  login [--config FILE]            add this machine to your Phosphor account
  status [--config FILE] [--json]   check this machine with the control plane
  logout [--config FILE] [--local]  remove it; --local only forgets it here
  version [--json]                  print the Host's version

exit codes: 0 ok, 1 an acceptance check failed, 64 usage, 69 prerequisite unavailable,
70 internal error, 75 control unavailable or code expired, 77 machine removed,
78 config invalid, 128+n ended by signal n
`

/** stdout carries only the report or JSON; everything else goes to stderr. */
export interface CliIo {
  stdout(text: string): void
  stderr(text: string): void
}

export type CliContext = Omit<DoctorContext, 'configPath'> & {
  /** Drain a running Host on a signal or a fatal error, until the returned function detaches it. */
  attach?: (target: Drainable) => () => void
  /** stdin and stdout are a terminal, which a login needs. */
  terminal?: boolean
  /** Replaced in tests: hands the terminal to a login. */
  runInTerminal?: LoginContext['run']
  /** Control-plane I/O replaced in tests. */
  control?: Pick<ControlContext, 'fetch' | 'now' | 'random' | 'signal' | 'wait' | 'store' | 'arch'>
}

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  doctor: ['config', 'json'],
  login: ['config'],
  status: ['config', 'json'],
  logout: ['config', 'local'],
  providers: ['config', 'json'],
  accept: [
    'config',
    'json',
    'repository',
    'lane',
    'keep-transcripts',
    'provider',
    'model',
    'claude-model',
  ],
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
  const login = command === 'providers' && extra[0] === 'login'
  const name = login ? 'providers login' : command
  const allowed = login ? ['config'] : COMMAND_OPTIONS[command]
  if (!allowed) return usage(`unknown command "${command}"`)
  if (login && extra.length === 1) {
    return usage('providers login needs a provider: an id phosphor providers lists, or claude')
  }
  const unexpected = extra[login ? 2 : 0]
  if (unexpected !== undefined) return usage(`unexpected argument "${unexpected}"`)
  const refused = Object.keys(values).find((option) => !allowed.includes(option))
  if (refused) return usage(`${name} does not take --${refused}`)
  if (login && !context.terminal) {
    return usage('providers login needs a terminal: over SSH, run ssh -t HOST phosphor ...')
  }
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
    if (['login', 'status', 'logout'].includes(command)) {
      const controller = new AbortController()
      const signal = context.control?.signal
        ? AbortSignal.any([controller.signal, context.control.signal])
        : controller.signal
      let finished: () => void = () => {}
      const done = new Promise<void>((resolve) => {
        finished = resolve
      })
      const detach = context.attach?.({
        drain: async () => {
          controller.abort()
          await done
          return { state: 'stopped' }
        },
        log: { write: () => {}, hide: () => 'The control command could not finish.' },
      })
      const control = {
        ...context,
        ...context.control,
        configPath,
        signal,
        print: (line: string) => io.stdout(`${line}\n`),
      }
      try {
        if (command === 'status') {
          const outcome = await runStatus(control)
          io.stdout(
            values.json ? `${JSON.stringify(outcome.report)}\n` : renderStatus(outcome.report),
          )
          return outcome.exitCode
        }
        const outcome =
          command === 'login' ? await runLogin(control) : await runLogout(control, values.local)
        io.stdout(`${outcome.message}\n`)
        return outcome.exitCode
      } finally {
        finished()
        detach?.()
      }
    }
    if (command === 'accept') {
      const outcome = await runAccept({
        ...context,
        configPath,
        repository: values.repository!,
        lane: lane as AcceptLane | 'all',
        keepTranscripts: values['keep-transcripts'] ?? false,
        provider: values.provider,
        claudeModel: values['claude-model'],
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
    if (login) {
      const outcome = await runProviderLogin({
        ...context,
        configPath,
        provider: extra[1]!,
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
    if (command === 'providers') {
      const outcome = await runProviders({ ...context, configPath })
      if ('problem' in outcome) {
        io.stderr(`phosphor: ${outcome.problem}\n`)
        const { doctor } = outcome
        io.stdout(values.json ? `${JSON.stringify(doctor, null, 2)}\n` : renderDoctor(doctor))
        return outcome.exitCode
      }
      const { report } = outcome
      io.stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderProviders(report))
      return report.exitCode
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
      local: { type: 'boolean' },
      repository: { type: 'string' },
      lane: { type: 'string' },
      'keep-transcripts': { type: 'boolean' },
      provider: { type: 'string' },
      'claude-model': { type: 'string' },
      model: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
}
