import { lstatSync, readlinkSync, readdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultConfigPath } from '../config/load'
import { hostStateDirectory } from '../lanes/state-dir'
import { checkedFolder } from '@phosphor/session-runtime/host-install/files'
import { acquireInstallLock, hasCode } from '@phosphor/session-runtime/host-install/lock'
import { commandLayout } from '@phosphor/session-runtime/host-install/layout'
import { installLifetime, signalTurn } from '../update/lifetime'
import { removeHostPathBlocks } from '../machine/shell-path'
import { runLogout } from './logout'
import { runService } from './service'
import { serviceState, type UpdateContext } from './update'

// Names reserved by the Host in its state root. An unrecognized entry is never ours to purge.
const stateEntries = new Set([
  'logs',
  'state.sqlite',
  'state.sqlite-wal',
  'state.sqlite-shm',
  'run.json',
  'service-exit.json',
  'attachments',
  'lane-transfer',
  'routines',
  'trash',
  'artifacts',
  'run',
  'update',
  'terminals.json',
  'local.json',
  'owner-standby.json',
  'update-result.json',
  'headroom.json',
  'app-services.json',
])
function checkedEntries(state: string) {
  const entries = readdirSync(state)
  if (entries.some((name) => !stateEntries.has(name)))
    throw new Error('State contains unknown entries; nothing in this folder will be purged.')
  return entries
}
function purgeState(state: string) {
  for (const name of checkedEntries(state)) rmSync(join(state, name), { recursive: true })
  // Never recursively remove the root: a foreign entry may have appeared since the check.
  rmdirSync(state)
}
export async function runUninstall(
  context: UpdateContext,
  purge = false,
  yes = false,
): Promise<number> {
  if (purge !== yes) {
    context.print('--purge and --yes are both required.')
    return 64
  }
  return installLifetime(context.attach, async (signal) => {
    let release: (() => void) | undefined
    try {
      const layout = commandLayout(context.home, context.update?.node, context.update?.bundle)
      if (layout) release = acquireInstallLock(layout.lib)
      const config = join(
        context.env.XDG_CONFIG_HOME ?? join(context.home, '.config'),
        'phosphor-host',
      )
      const state = hostStateDirectory(context.env, context.home)
      const safe = (path: string) => checkedFolder(path, path, context.home, context.uid)
      if (layout) safe(layout.lib)
      if (purge) {
        safe(config)
        const hasState = safe(state)
        if (context.configPath !== defaultConfigPath(context.env, context.home)) {
          context.print('Purge requires the default config path.')
          return 64
        }
        if (hasState) checkedEntries(state)
        const result = await runLogout({ ...context, signal })
        if (result.exitCode !== 0) {
          context.print('Logout failed; nothing was uninstalled.')
          return 75
        }
      }
      signal.throwIfAborted()
      if (
        (await serviceState(context)).installed &&
        (await runService({ ...context, signal }, 'uninstall')) !== 0
      )
        return 75
      signal.throwIfAborted()
      if (layout) {
        safe(layout.lib)
        const launcher = join(context.home, '.local/bin/phosphor')
        // Never follow a link in the launcher's parent or remove a foreign launcher.
        checkedFolder(
          join(context.home, '.local/bin'),
          join(context.home, '.local/bin'),
          context.home,
          context.uid,
        )
        try {
          if (
            lstatSync(launcher).isSymbolicLink() &&
            readlinkSync(launcher) === join(layout.current, 'bin/phosphor')
          )
            unlinkSync(launcher)
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) throw error
        }
        for (const name of readdirSync(layout.lib))
          if (name !== '.install-lock')
            rmSync(join(layout.lib, name), { recursive: true, force: true })
        release?.()
        release = undefined
        // A new installer can win after release. Never remove its lock or program.
        try {
          rmdirSync(layout.lib)
        } catch (error) {
          if (!hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EEXIST')) throw error
        }
      } else
        context.print(
          `Source install: remove the bundle folder ${dirname(context.update?.bundle ?? process.argv[1] ?? 'phosphor.mjs')}.`,
        )
      removeHostPathBlocks(context.home, context.uid)
      if (purge) {
        if (safe(state)) purgeState(state)
        if (safe(config)) rmSync(config, { recursive: true })
      } else context.print(`Kept config and identity: ${config}; state: ${state}`)
      reportBackup(context)
      await signalTurn()
      signal.throwIfAborted()
      context.print('Host uninstalled.')
      return 0
    } catch (error) {
      if (signal.aborted) return typeof signal.reason === 'number' ? signal.reason : 70
      context.print(
        error instanceof Error &&
          /^(Install lock:|State contains unknown entries;)/.test(error.message)
          ? error.message
          : 'Host uninstall could not finish safely.',
      )
      return 75
    } finally {
      release?.()
    }
  })
}

function reportBackup(context: UpdateContext) {
  const backup = join(context.home, '.local/bin/phosphor.before-release')
  try {
    lstatSync(backup)
    context.print(`Previous launcher kept at ${backup}`)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
}
