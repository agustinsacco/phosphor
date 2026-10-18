import { errorText } from '@phosphor/shared/errors'
import { HOST_PROTOCOL_VERSION } from '@phosphor/shared/remote-host'
import { createHostLog, hostLogDirectory } from './machine/log'
import { EXIT } from './checks'
import { readCliRequest, supervisedRun } from './cli-args'
import { refuseUsage, USAGE } from './cli-usage'
import { renderAccept, runAccept } from './commands/accept'
import { renderDoctor, runDoctor, type DoctorContext } from './commands/doctor'
import { renderSetup, runSetup, type SetupReport } from './commands/setup'
import { installHostPath } from './machine/shell-path'
import { runGuidedSetup } from './commands/guided-setup'
import type { LoginContext } from './commands/provider-login'
import { renderProviders, runProviders } from './commands/providers'
import { runProviderLogin } from './commands/provider-login'
import { runHost, type RunContext } from './commands/run'
import { runService, type ServiceContext } from './commands/service'
import { runLogin } from './commands/login'
import { runLogout } from './commands/logout'
import { renderStatus, runStatus } from './commands/status'
import type { ControlContext } from './control/command'
import { createIdentityStore, identityDirectory } from './control/identity'
import { defaultConfigPath } from './config/load'
import type { Drainable } from './shutdown'
import { HOST_SOURCE_SHA, HOST_VERSION } from './version'
import { runUpdate, type UpdateContext } from './commands/update'
import { runUninstall } from './commands/uninstall'
import { runTailscale } from './commands/tailscale'

export { CLI_PARSE_CONFIG, scannedCommand, supervisedRun } from './cli-args'
export { USAGE } from './cli-usage'

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

export async function runCli(
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
  const { command } = request
  const values = command.options
  try {
    if (command.name === 'version') {
      const version = {
        hostVersion: HOST_VERSION,
        protocolVersion: HOST_PROTOCOL_VERSION,
        sourceSha: HOST_SOURCE_SHA,
        node: context.nodeVersion,
      }
      io.stdout(values.json ? `${JSON.stringify(version)}\n` : `phosphor ${HOST_VERSION}\n`)
      return EXIT.ok
    }
    if (command.name === 'internal-install-path') {
      installHostPath({ ...context, print: (line) => io.stdout(`${line}\n`) })
      return EXIT.ok
    }
    const configPath = values.config ?? defaultConfigPath(context.env, context.home)
    if (command.name === 'tailscale') {
      const outcome = await runTailscale(
        { ...context, configPath },
        command.action,
        context.tailscale,
      )
      io.stdout(`${outcome.message}\n`)
      return outcome.exitCode
    }
    if (command.name === 'update' || command.name === 'uninstall') {
      const messages: string[] = []
      const install = {
        ...context,
        json: values.json,
        ...context.control,
        configPath,
        print: (line: string) => {
          if (messages.length < 256) messages.push(line)
        },
      }
      const exitCode =
        command.name === 'update'
          ? await runUpdate(install, values)
          : await runUninstall(install, values.purge, values.yes)
      io.stdout(
        values.json ? `${JSON.stringify({ exitCode, messages })}\n` : messages.join('\n') + '\n',
      )
      return exitCode
    }
    if (command.name === 'setup') {
      if (!context.terminal) {
        const report = await runSetup({
          ...context,
          cwd: context.cwd ?? process.cwd(),
          configPath,
          repositories: command.repositories,
          pi: values.pi,
          node: values.node,
          replace: values.replace,
          tailscaleHints: false,
        })
        // Point at login only when this machine is not on an account yet.
        const enrolled = await createIdentityStore(
          identityDirectory(configPath),
          process.getuid?.(),
        )
          .load()
          .then((loaded) => loaded !== null)
          .catch(() => false)
        if (report.exitCode === EXIT.ok && !enrolled) report.next = 'phosphor login'
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
          json: values.json,
          ...context.control,
          cwd: context.cwd ?? process.cwd(),
          configPath,
          repositories: command.repositories,
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
      if (values.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`)
      return report.exitCode
    }
    const controlLog = ['login', 'status', 'logout', 'run', 'service'].includes(command.name)
      ? createHostLog(
          hostLogDirectory(context.env, context.home),
          Object.values(context.env).filter(
            (value): value is string => typeof value === 'string' && value.length >= 8,
          ),
        )
      : null
    if (command.name === 'run' || command.name === 'service') {
      const controller = new AbortController()
      let done: () => void = () => {}
      const ended = new Promise<void>((resolve) => {
        done = resolve
      })
      const detach =
        command.name === 'service'
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
        if (command.name === 'run') return await runHost({ ...run, supervisor: command.supervisor })
        return await runService(run, command.action, values.follow)
      } finally {
        done()
        detach?.()
      }
    }
    if (['login', 'status', 'logout'].includes(command.name)) {
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
        if (command.name === 'status') {
          const outcome = await runStatus(control)
          io.stdout(
            values.json ? `${JSON.stringify(outcome.report)}\n` : renderStatus(outcome.report),
          )
          return outcome.exitCode
        }
        const outcome =
          command.name === 'login'
            ? await runLogin(control)
            : await runLogout(control, values.local)
        io.stdout(`${outcome.message}\n`)
        return outcome.exitCode
      } finally {
        finished()
        detach?.()
      }
    }
    if (command.name === 'accept') {
      const outcome = await runAccept({
        ...context,
        configPath,
        repository: command.repository,
        lane: command.lane,
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
    if (command.name === 'providers login') {
      const outcome = await runProviderLogin({
        ...context,
        configPath,
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
    if (command.name === 'providers') {
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
