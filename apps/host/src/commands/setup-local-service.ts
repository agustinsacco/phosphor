import { open } from 'node:fs/promises'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { serviceProgram } from '@phosphor/session-runtime/host-install/layout'
import { HOST_SIDECARS, parseLocalRunFile } from '@phosphor/shared/host-local'
import { readSidecar } from '../config/sidecar'
import { loadHostConfig, defaultConfigPath } from '../config/load'
import { hostStateDirectory, prepareStateDirectory } from '../lanes/state-dir'
import { HOST_AGENT, HOST_UNIT } from '@phosphor/shared/host-local'
import { launchAgentPlist, launchctlMissing } from '../machine/launchd'
import { serviceUnit, writeServiceUnit, type ServiceRunner } from '../machine/systemd'
import { HOST_VERSION } from '../version'
import { readRunHealth } from '../update/health'
import type { ServiceContext } from './service'

export const SERVICE_LOG_NAMES: readonly string[] = [
  'phosphor.log',
  'phosphor.log.1',
  'launchd.err.log',
]

function alreadyRunning(context: ServiceContext, state: string, pid: number): number {
  const local = readSidecar(state, HOST_SIDECARS.localRun, parseLocalRunFile, context)
  const run = readRunHealth(state)
  if (
    (local.state === 'ok' && local.value.pid === pid && local.value.hostVersion === HOST_VERSION) ||
    (run?.pid === pid && run.version === HOST_VERSION)
  ) {
    context.print('The Phosphor service is already running.')
    return 0
  }
  context.print(
    'An existing service is loaded. Check its version before adopting it; nothing was restarted.',
  )
  return 75
}

export async function runLocalServiceInstall(
  context: ServiceContext,
  invoke: ServiceRunner,
): Promise<number> {
  const config = resolve(context.configPath)
  if (!(await loadHostConfig(config, context.uid)).ok) {
    context.print('The service config is not usable.')
    return 78
  }
  const { node, bundle, path } = localProgram(context)
  const state = hostStateDirectory(context.env, context.home)
  const xdg = {
    XDG_CONFIG_HOME: dirname(dirname(defaultConfigPath(context.env, context.home))),
    XDG_STATE_HOME: dirname(state),
  }
  prepareStateDirectory(state, context.uid)
  const write = context.service?.write ?? writeServiceUnit
  const darwin = context.platform === 'darwin'
  const label = context.service?.localLabel ?? (darwin ? HOST_AGENT : HOST_UNIT)
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(label)) throw new Error('Invalid service label.')
  if (darwin) {
    const domain = `gui/${context.uid}`
    const status = await invoke('launchctl', ['print', `${domain}/${label}`])
    if (status.code === 0)
      return alreadyRunning(context, state, Number(/^\s*pid = (\d+)\s*$/m.exec(status.stdout)?.[1]))
    if (!launchctlMissing('print', status.code)) return 69
    const logs = join(state, 'logs')
    prepareStateDirectory(logs, context.uid)
    await prepareLaunchdStderr(logs)
    const plist = join(context.home, 'Library', 'LaunchAgents', `${label}.plist`)
    await write(plist, launchAgentPlist(node, bundle, config, path, logs, xdg, label))
    // RunAtLoad starts it. No bootout or forced kickstart, even in a race.
    return (await invoke('launchctl', ['bootstrap', domain, plist])).code === 0 ? 0 : 75
  }
  const call = (args: string[]) => invoke('systemctl', ['--user', ...args])
  const status = await call(['is-active', '--quiet', label])
  if (status.code === 0) {
    const result = await call(['show', label, '-p', 'MainPID', '--value'])
    const code = alreadyRunning(context, state, Number(result.stdout.trim()))
    if (code !== 0) return code
  } else {
    if (status.code !== 3 && status.code !== 4) {
      context.print('The systemd user service manager is unavailable.')
      return 69
    }
    const unit = join(xdg.XDG_CONFIG_HOME, 'systemd', 'user', label)
    await write(unit, serviceUnit(node, bundle, config, path, xdg))
    if (
      (await call(['daemon-reload'])).code !== 0 ||
      (await call(['enable', '--now', label])).code !== 0
    )
      return 75
  }
  if (context.service?.linger) {
    const user = context.service.user ?? userInfo().username
    if (!/^[a-z_][a-z0-9_-]{0,31}\$?$/i.test(user)) return 78
    if ((await invoke('loginctl', ['enable-linger', user])).code !== 0)
      context.print('Could not enable linger.')
  }
  return 0
}

function localProgram(context: ServiceContext) {
  const { node, bundle } = serviceProgram(
    context.service?.node ?? process.execPath,
    context.service?.bundle ?? resolve(process.argv[1] ?? ''),
    context.home,
  )
  const path = [
    dirname(node),
    ...(context.env.PATH ?? '').split(':').filter((d) => d && d !== dirname(node)),
  ].join(':')
  return { node, bundle, path }
}

/** launchd creates a missing stderr file with its own umask. Make it private on first use. */
async function prepareLaunchdStderr(logs: string) {
  try {
    const fd = await open(join(logs, 'launchd.err.log'), 'wx', 0o600)
    await fd.close()
  } catch (error) {
    if (!errnoIs(error, 'EEXIST')) throw error
  }
}
