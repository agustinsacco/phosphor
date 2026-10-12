import { userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { controlResult, prepareControl, withCommandLock } from '../control/command'
import { IdentityFailure } from '../control/identity'
import {
  HOST_UNIT,
  serviceRunner,
  serviceUnit,
  writeServiceUnit,
  removeServiceUnit,
  type ServiceRunner,
} from '../machine/systemd'
import { renderStatus, runStatus } from './status'
import type { RunContext } from './run'

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
export async function runService(
  context: ServiceContext,
  action: ServiceAction,
  follow = false,
): Promise<number> {
  if (context.platform !== 'linux') {
    context.print('not supported on this platform yet')
    return 69
  }
  const runner =
    context.service?.runner ?? serviceRunner(context.env, context.print, context.signal)
  const call = (args: readonly string[]) => runner('systemctl', ['--user', ...args])
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
      const text = serviceUnit(
        context.service?.node ?? process.execPath,
        context.service?.bundle ?? resolve(process.argv[1] ?? ''),
        resolve(context.configPath),
        context.env.PATH ?? '',
      )
      await (context.service?.write ?? writeServiceUnit)(unit, text)
      if (
        (await call(['daemon-reload'])).code !== 0 ||
        (await call(['enable', '--now', HOST_UNIT])).code !== 0 ||
        (await call(['restart', HOST_UNIT])).code !== 0
      ) {
        context.print(
          'The service could not be installed. Check systemctl --user status phosphor-host.service.',
        )
        return 75
      }
      if ((await runner('loginctl', ['enable-linger', user])).code !== 0)
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
      const result = await runner(
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
      const linger = await runner('loginctl', ['show-user', user, '-p', 'Linger', '--value'])
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
