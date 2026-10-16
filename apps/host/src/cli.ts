import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { errorText } from '@phosphor/shared/errors'
import { HOST_PROTOCOL_VERSION } from '@phosphor/shared/remote-host'
import { createHostLog, hostLogDirectory } from './machine/log'
import { EXIT } from './checks'
import { renderAccept, runAccept, type AcceptLane } from './commands/accept'
import { renderDoctor, runDoctor, type DoctorContext } from './commands/doctor'
import { renderSetup, runSetup, type SetupReport } from './commands/setup'
import { installHostPath } from './machine/shell-path'
import { runGuidedSetup } from './commands/guided-setup'
import type { LoginContext } from './commands/provider-login'
import { renderProviders, runProviders } from './commands/providers'
import { runProviderLogin } from './commands/provider-login'
import { runHost, type RunContext } from './commands/run'
import { runService, isServiceAction, type ServiceContext } from './commands/service'
import { runLogin } from './commands/login'
import { runLogout } from './commands/logout'
import { renderStatus, runStatus } from './commands/status'
import type { ControlContext } from './control/command'
import { defaultConfigPath } from './config/load'
import type { Drainable } from './shutdown'
import { HOST_SOURCE_SHA, HOST_VERSION } from './version'
import { runUpdate, type UpdateContext } from './commands/update'
import { runUninstall } from './commands/uninstall'
import { HOST_RELEASE_VERSION_PATTERN } from '@phosphor/shared/host-release'
import { launchdExit } from './machine/launchd'
import { isTailscaleAction, runTailscale } from './commands/tailscale'

export const USAGE = `usage: phosphor <command>

Set up a Host: phosphor setup. Re-run it to resume or finish setup.

  setup [--repository DIR]... [--pi FILE] [--node FILE] [--replace]
        [--config FILE] [--json]    configure, sign in, start the user service and enable Tailscale
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
  run [--config FILE] [--supervisor launchd]
                                    keep this machine online with heartbeats
  service install|status|restart|logs|uninstall [--config FILE]
                                    manage the Linux or macOS user service; logs takes --follow
  tailscale status|enable|disable [--config FILE]
                                    expose the loopback API on your tailnet, never Funnel
  update [--version X.Y.Z] [--check] [--json]
  update --rollback [--json]        select the previous installed release offline
  uninstall [--purge --yes] [--json] remove the program and service; keep data by default
  version [--json]                  print the Host's version

exit codes: 0 ok, 1 an acceptance check failed, 64 usage, 69 prerequisite unavailable,
70 internal error, 75 control unavailable, code expired or concurrent setup, 77 machine removed,
78 config invalid, 128+n ended by signal n
`

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

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  'internal-install-path': [],
  setup: ['config', 'json', 'repository', 'pi', 'node', 'replace'],
  doctor: ['config', 'json'],
  run: ['config', 'supervisor'],
  service: ['config', 'follow'],
  tailscale: ['config'],
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
  update: ['version', 'check', 'rollback', 'json'],
  uninstall: ['purge', 'yes', 'json'],
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const supervised = supervisedRun(argv)
  const usage = async (problem: string) => {
    io.stderr(`phosphor: ${problem}\n\n${USAGE}`)
    if (!supervised) return EXIT.usage
    try {
      const log = createHostLog(hostLogDirectory(context.env, context.home), [])
      log.write('service', 'stopped', { code: EXIT.usage })
      return await launchdExit(
        EXIT.usage,
        context.env,
        context.home,
        context.control?.now?.() ?? Date.now(),
      )
    } catch {
      io.stderr('The service command could not finish.\n')
      return 75
    }
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
  const service = command === 'service'
  if (service && !isServiceAction(extra[0]))
    return usage('service needs install, status, restart, logs or uninstall')
  if (service && values.follow && extra[0] !== 'logs')
    return usage('--follow is only for service logs')
  const tailscale = command === 'tailscale'
  if (tailscale && !isTailscaleAction(extra[0]))
    return usage('tailscale needs status, enable or disable')
  const unexpected = extra[login ? 2 : service || tailscale ? 1 : 0]
  if (unexpected !== undefined) return usage(`unexpected argument "${unexpected}"`)
  const refused = Object.keys(values).find((option) => !allowed.includes(option))
  if (refused) return usage(`${name} does not take --${refused}`)
  if (login && !context.terminal) {
    return usage('providers login needs a terminal: over SSH, run ssh -t HOST phosphor ...')
  }
  if (values.supervisor !== undefined && values.supervisor !== 'launchd')
    return usage('--supervisor is launchd')
  if (values.config === '') return usage('--config needs a file')
  const lane = values.lane ?? 'all'
  if (!['native', 'claude', 'all'].includes(lane)) return usage('--lane is native, claude or all')
  const repositories = values.repository ?? []
  const repository = repositories[0]
  if (command !== 'setup' && repositories.length > 1)
    return usage('--repository may only repeat for setup')
  if (command === 'accept' && !repository) return usage('accept needs --repository DIR')
  if (command !== 'setup' && repository !== undefined && !isAbsolute(repository)) {
    return usage('--repository needs an absolute path')
  }
  if (
    command === 'setup' &&
    (repositories.includes('') || values.pi === '' || values.node === '')
  ) {
    return usage('--repository, --pi and --node need a path')
  }

  if (
    command === 'update' &&
    ((values.version !== undefined && !HOST_RELEASE_VERSION_PATTERN.test(values.version)) ||
      (values.rollback && (values.version !== undefined || values.check)))
  )
    return usage('invalid update options')
  if (command === 'uninstall' && Boolean(values.purge) !== Boolean(values.yes))
    return usage('--purge and --yes are both required')

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
    if (command === 'internal-install-path') {
      installHostPath({ ...context, print: (line) => io.stdout(`${line}\n`) })
      return EXIT.ok
    }
    const configPath = values.config ?? defaultConfigPath(context.env, context.home)
    if (tailscale && isTailscaleAction(extra[0])) {
      const outcome = await runTailscale({ ...context, configPath }, extra[0], context.tailscale)
      io.stdout(`${outcome.message}\n`)
      return outcome.exitCode
    }
    if (command === 'update' || command === 'uninstall') {
      const messages: string[] = []
      const install = {
        ...context,
        ...context.control,
        configPath,
        print: (line: string) => {
          if (messages.length < 256) messages.push(line)
        },
      }
      const exitCode =
        command === 'update'
          ? await runUpdate(install, values)
          : await runUninstall(install, values.purge, values.yes)
      io.stdout(
        values.json ? `${JSON.stringify({ exitCode, messages })}\n` : messages.join('\n') + '\n',
      )
      return exitCode
    }
    if (command === 'setup') {
      if (!context.terminal) {
        const report = await runSetup({
          ...context,
          cwd: context.cwd ?? process.cwd(),
          configPath,
          repositories,
          pi: values.pi,
          node: values.node,
          replace: values.replace,
          tailscaleHints: false,
        })
        if (report.exitCode === EXIT.ok) report.next = 'phosphor login'
        io.stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderSetup(report))
        return report.exitCode
      }
      const controller = new AbortController()
      let finished = () => {}
      const ended = new Promise<void>((resolve) => {
        finished = resolve
      })
      const detach = context.attach?.({
        drain: async () => {
          controller.abort()
          await ended
          return { state: 'stopped' }
        },
        log: { write: () => {}, hide: () => 'Setup could not finish.' },
      })
      let report: SetupReport
      try {
        report = await runGuidedSetup({
          ...context,
          ...context.control,
          cwd: context.cwd ?? process.cwd(),
          configPath,
          repositories,
          pi: values.pi,
          node: values.node,
          replace: values.replace,
          signal: context.control?.signal
            ? AbortSignal.any([controller.signal, context.control.signal])
            : controller.signal,
          print: (line) => (values.json ? io.stderr : io.stdout)(`${line}\n`),
        })
      } finally {
        finished()
        detach?.()
      }
      io.stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderSetup(report))
      return report.exitCode
    }
    const controlLog = ['login', 'status', 'logout', 'run', 'service'].includes(command)
      ? createHostLog(
          hostLogDirectory(context.env, context.home),
          Object.values(context.env).filter(
            (value): value is string => typeof value === 'string' && value.length >= 8,
          ),
        )
      : null
    if (command === 'run' || service) {
      const controller = new AbortController()
      let done: () => void = () => {}
      const ended = new Promise<void>((resolve) => {
        done = resolve
      })
      const detach = service
        ? context.attach?.({
            drain: async () => {
              controller.abort()
              await ended
              return { state: 'stopped' }
            },
            log: { write: () => {}, hide: () => 'The service command could not finish.' },
          })
        : undefined
      const run = {
        ...context,
        ...context.control,
        log: controlLog?.write,
        configPath,
        signal: context.control?.signal
          ? AbortSignal.any([controller.signal, context.control.signal])
          : controller.signal,
        print: (line: string) => io.stdout(line.endsWith('\n') ? line : `${line}\n`),
      }
      try {
        if (command === 'run')
          return await runHost({
            ...run,
            supervisor: values.supervisor === 'launchd' ? 'launchd' : undefined,
          })
        if (isServiceAction(extra[0])) return await runService(run, extra[0], values.follow)
      } finally {
        done()
        detach?.()
      }
    }
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
        log: controlLog?.write,
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
        repository: repository!,
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

export const CLI_PARSE_CONFIG = {
  allowPositionals: true,
  strict: true,
  options: {
    config: { type: 'string' },
    version: { type: 'string' },
    check: { type: 'boolean' },
    rollback: { type: 'boolean' },
    purge: { type: 'boolean' },
    yes: { type: 'boolean' },
    supervisor: { type: 'string' },
    json: { type: 'boolean' },
    local: { type: 'boolean' },
    follow: { type: 'boolean' },
    repository: { type: 'string', multiple: true },
    pi: { type: 'string' },
    node: { type: 'string' },
    replace: { type: 'boolean' },
    lane: { type: 'string' },
    'keep-transcripts': { type: 'boolean' },
    provider: { type: 'string' },
    'claude-model': { type: 'string' },
    model: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
} as const

function scanArgv(argv: readonly string[]): {
  command: string | undefined
  supervisors: (string | undefined)[]
} {
  let command: string | undefined
  const supervisors: (string | undefined)[] = []
  let positional = false
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === undefined) continue
    if (!positional && token === '--') {
      positional = true
      continue
    }
    if (!positional && token.startsWith('-') && token !== '-') {
      const equal = token.indexOf('=')
      const name = token.startsWith('--')
        ? token.slice(2, equal < 0 ? undefined : equal)
        : undefined
      const option = Object.entries(CLI_PARSE_CONFIG.options).find(
        ([long, option]) => name === long || ('short' in option && token === `-${option.short}`),
      )
      if (option?.[1].type === 'string') {
        const value = equal < 0 ? argv[++index] : token.slice(equal + 1)
        if (option[0] === 'supervisor') supervisors.push(value)
      }
      continue
    }
    command ??= token
  }
  return { command, supervisors }
}

export function scannedCommand(argv: readonly string[]): string | undefined {
  return scanArgv(argv).command
}
export function supervisedRun(argv: readonly string[]): boolean {
  const { command, supervisors } = scanArgv(argv)
  return (
    command === 'run' && supervisors.length > 0 && supervisors.every((value) => value === 'launchd')
  )
}

function parse(argv: readonly string[]) {
  return parseArgs({ ...CLI_PARSE_CONFIG, args: [...argv] })
}
