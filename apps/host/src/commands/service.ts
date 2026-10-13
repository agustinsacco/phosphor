import { mkdir } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { traceCommand, controlResult, prepareControl, withCommandLock } from '../control/command'
import { IdentityFailure } from '../control/identity'
import {
  HOST_UNIT,
  serviceRunner,
  serviceUnit,
  writeServiceUnit,
  removeServiceUnit,
  type ServiceRunner,
} from '../machine/systemd'
import {
  HOST_AGENT,
  launchAgentPlist,
  launchctlMissing,
  launchdStatusLines,
  readLogTail,
  readServiceExit,
  serviceExitPath,
} from '../machine/launchd'
import { hostLogDirectory } from '../machine/log'
import { renderStatus, runStatus } from './status'
import type { RunContext } from './run'
import { serviceProgram } from '../update/layout'

export type ServiceAction = 'install' | 'status' | 'restart' | 'logs' | 'uninstall'
export function isServiceAction(value: unknown): value is ServiceAction {
  return (
    value === 'install' ||
    value === 'status' ||
    value === 'restart' ||
    value === 'logs' ||
    value === 'uninstall'
  )
}
export interface ServiceContext extends RunContext {
  home: string
  service?: {
    runner?: ServiceRunner
    node?: string
    bundle?: string
    user?: string
    write?: typeof writeServiceUnit
    remove?: typeof removeServiceUnit
  }
}
async function runServiceCommand(
  context: ServiceContext,
  action: ServiceAction,
  follow = false,
): Promise<number> {
  if (context.platform !== 'linux' && context.platform !== 'darwin') {
    context.print('not supported on this platform yet')
    return 69
  }
  const runner =
    context.service?.runner ?? serviceRunner(context.env, context.print, context.signal)
  const invoke: ServiceRunner = async (program, args, stream) => {
    context.log?.('service', 'exec', { program, args, trace: context.trace })
    const result = await runner(program, args, stream)
    context.log?.('service', 'exec.finished', {
      program,
      exitCode: result.code,
      trace: context.trace,
    })
    return result
  }
  if (context.platform === 'darwin') return runLaunchdService(context, action, follow, invoke)
  const call = (args: readonly string[]) => invoke('systemctl', ['--user', ...args])
  const unit = join(
    context.env.XDG_CONFIG_HOME ?? join(context.home, '.config'),
    'systemd',
    'user',
    HOST_UNIT,
  )
  const user = context.service?.user ?? userInfo().username
  try {
    if (!unit.startsWith('/') || unit.length > 65536 || /[\p{Cc}\u2028\u2029]/u.test(unit))
      throw new IdentityFailure(
        'Service directory must be an absolute path without control characters.',
      )
    if (!/^[a-z_][a-z0-9_-]{0,31}\$?$/i.test(user))
      throw new IdentityFailure('Service user name is not usable.')
    if (action === 'install') {
      const prepared = await withCommandLock(context, () => prepareControl(context))
      if (!prepared.loaded) {
        context.print('Run phosphor login first.')
        return 69
      }
      const { node, bundle } = serviceProgram(
        context.service?.node ?? process.execPath,
        context.service?.bundle ?? resolve(process.argv[1] ?? ''),
        context.home,
      )
      // The node directory leads: a version manager's shell entry (fnm's per-shell
      // multishell directory) is gone after logout, while execPath is the real path.
      const nodeDir = dirname(node)
      const path = [nodeDir, ...(context.env.PATH ?? '').split(':').filter((d) => d !== nodeDir)]
      const text = serviceUnit(
        node,
        bundle,
        resolve(context.configPath),
        path.filter(Boolean).join(':'),
      )
      await (context.service?.write ?? writeServiceUnit)(unit, text)
      context.log?.('service', 'unit.written', { path: unit, trace: context.trace })
      if (
        (await call(['daemon-reload'])).code !== 0 ||
        // restart also starts a stopped unit. enable --now first would start one
        // run only for restart to stop it a few milliseconds later.
        (await call(['enable', HOST_UNIT])).code !== 0 ||
        (await call(['restart', HOST_UNIT])).code !== 0
      ) {
        context.print(
          'The service could not be installed. Check systemctl --user status phosphor-host.service.',
        )
        return 75
      }
      if ((await invoke('loginctl', ['enable-linger', user])).code !== 0)
        context.print(
          `The service is running. To keep it running after logout, run: sudo loginctl enable-linger ${user}`,
        )
      else context.print('Phosphor Host service is running with linger enabled.')
      return 0
    }
    if (action === 'uninstall') {
      // A missing unit is already uninstalled. Always finish the local removal and reload.
      if ((await call(['disable', '--now', HOST_UNIT])).code !== 0) {
        const loaded = await call(['show', HOST_UNIT, '-p', 'LoadState', '--value'])
        if (loaded.code !== 0 || loaded.stdout.trim() !== 'not-found') {
          context.print('The service could not be stopped.')
          return 75
        }
      }
      await (context.service?.remove ?? removeServiceUnit)(unit)
      context.log?.('service', 'unit.removed', { path: unit, trace: context.trace })
      if ((await call(['daemon-reload'])).code !== 0) {
        context.print('The service manager could not reload.')
        return 75
      }
      context.print('Phosphor Host service is uninstalled.')
      return 0
    }
    if (action === 'restart') {
      if ((await call(['restart', HOST_UNIT])).code === 0) {
        context.print('Phosphor Host service restarted.')
        return 0
      }
    } else if (action === 'logs') {
      const result = await invoke(
        'journalctl',
        ['--user', '-u', HOST_UNIT, '-n', '200', '--no-pager', ...(follow ? ['-f'] : [])],
        true,
      )
      if (result.stdout) context.print(result.stdout)
      if (result.code === 0) return 0
    } else {
      const result = await call([
        'show',
        HOST_UNIT,
        '-p',
        'ActiveState,SubState,MainPID,ExecMainStatus',
      ])
      if (result.code !== 0) {
        context.print('The service state could not be read.')
        return 75
      }
      for (const line of result.stdout.split('\n')) {
        if (
          /^(?:ActiveState|SubState)=[a-z-]{1,40}$/.test(line) ||
          /^(?:MainPID|ExecMainStatus)=\d{1,10}$/.test(line)
        )
          context.print(line)
      }
      const linger = await invoke('loginctl', ['show-user', user, '-p', 'Linger', '--value'])
      context.print(
        `Linger: ${linger.code !== 0 ? 'unknown' : linger.stdout.trim() === 'yes' ? 'on' : 'off'}`,
      )
      const status = await runStatus(context)
      context.print(renderStatus(status.report).trimEnd())
      return status.exitCode
    }
    context.print('The service command could not finish.')
    return 75
  } catch (error) {
    const result = controlResult(error, context.signal)
    context.print(result.message)
    return result.exitCode
  }
}

async function runLaunchdService(
  context: ServiceContext,
  action: ServiceAction,
  follow: boolean,
  invoke: ServiceRunner,
): Promise<number> {
  const plist = join(context.home, 'Library', 'LaunchAgents', `${HOST_AGENT}.plist`)
  const logDir = hostLogDirectory(context.env, context.home)
  const domain = `gui/${context.uid}`
  const job = `${domain}/${HOST_AGENT}`
  const fail = (message = 'The service command could not finish.') => {
    context.print(message)
    return 75
  }
  const bootout = async () => {
    const result = await invoke('launchctl', ['bootout', job])
    return result.code === 0 || launchctlMissing('bootout', result.code)
  }
  try {
    if (
      ![plist, logDir].every(
        (path) =>
          path.startsWith('/') && path.length <= 65536 && !/[\p{Cc}\u2028\u2029]/u.test(path),
      )
    )
      throw new IdentityFailure(
        'Service directory must be an absolute path without control characters.',
      )
    if (context.uid === undefined || !Number.isSafeInteger(context.uid) || context.uid < 0)
      throw new IdentityFailure('Service user name is not usable.')
    if (action === 'install') {
      const prepared = await withCommandLock(context, () => prepareControl(context))
      if (!prepared.loaded) {
        context.print('Run phosphor login first.')
        return 69
      }
      const { node, bundle } = serviceProgram(
        context.service?.node ?? process.execPath,
        context.service?.bundle ?? resolve(process.argv[1] ?? ''),
        context.home,
      )
      const nodeDir = dirname(node)
      const path = [nodeDir, ...(context.env.PATH ?? '').split(':').filter((d) => d !== nodeDir)]
        .filter(Boolean)
        .join(':')
      const text = launchAgentPlist(node, bundle, resolve(context.configPath), path, logDir)
      await mkdir(logDir, { recursive: true, mode: 0o700 })
      await (context.service?.write ?? writeServiceUnit)(plist, text)
      context.log?.('service', 'unit.written', { path: plist, trace: context.trace })
      if (
        !(await bootout()) ||
        (await invoke('launchctl', ['bootstrap', domain, plist])).code !== 0 ||
        (await invoke('launchctl', ['kickstart', '-k', job])).code !== 0
      )
        return fail('The service could not be installed. Run phosphor service status to check it.')
      context.print('Phosphor Host service is running.')
      return 0
    }
    if (action === 'uninstall') {
      if (!(await bootout())) return fail('The service could not be stopped.')
      await (context.service?.remove ?? removeServiceUnit)(plist)
      context.log?.('service', 'unit.removed', { path: plist, trace: context.trace })
      context.print('Phosphor Host service is uninstalled.')
      return 0
    }
    if (action === 'restart') {
      const result = await invoke('launchctl', ['kickstart', '-k', job])
      if (launchctlMissing('kickstart', result.code))
        return fail('The service is not loaded. Run phosphor service install.')
      if (result.code !== 0) return fail()
      context.print('Phosphor Host service restarted.')
      return 0
    }
    if (action === 'logs') {
      const hostLog = join(logDir, 'phosphor.log')
      let end = 0
      try {
        const tail = await readLogTail(hostLog, 200)
        end = tail.end
        if (tail.text) context.print(tail.text)
      } catch (error) {
        if (!(follow && error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          throw error
      }
      try {
        const tail = await readLogTail(join(logDir, 'launchd.err.log'), 50)
        if (tail.text) context.print(tail.text)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      if (follow && (await invoke('tail', ['-c', `+${end + 1}`, '-F', hostLog], true)).code !== 0)
        return fail()
      return 0
    }
    const result = await invoke('launchctl', ['print', job])
    const reason = await readServiceExit(serviceExitPath(context.env, context.home))
    if (reason) context.print(`Stopped permanently: ${reason}`)
    if (result.code !== 0) return fail('The service state could not be read.')
    for (const line of launchdStatusLines(result.stdout)) context.print(line)
    const status = await runStatus(context)
    context.print(renderStatus(status.report).trimEnd())
    return status.exitCode
  } catch (error) {
    if (error instanceof IdentityFailure) {
      context.print(error.message)
      return 78
    }
    return fail()
  }
}

export function runService(
  context: ServiceContext,
  action: ServiceAction,
  follow = false,
): Promise<number> {
  return traceCommand(context, `service.${action}`, (traced) =>
    runServiceCommand({ ...context, ...traced }, action, follow),
  )
}
