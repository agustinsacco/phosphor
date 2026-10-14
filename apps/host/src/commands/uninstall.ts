import { lstatSync, readlinkSync, readdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultConfigPath } from '../config/load'
import { hostStateDirectory } from '../lanes/state-dir'
import { checkedFolder } from '../update/files'
import { acquireInstallLock, hasCode } from '../update/lock'
import { commandLayout } from '../update/layout'
import { installLifetime, signalTurn } from '../update/lifetime'
import { runLogout } from './logout'
import { runService } from './service'
import { serviceState, type UpdateContext } from './update'

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
        safe(state)
        if (context.configPath !== defaultConfigPath(context.env, context.home)) {
          context.print('Purge requires the default config path.')
          return 64
        }
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
      if (purge) {
        for (const path of [config, state]) if (safe(path)) rmSync(path, { recursive: true })
      } else context.print(`Kept config and identity: ${config}; state: ${state}`)
      const backup = join(context.home, '.local/bin/phosphor.before-release')
      try {
        lstatSync(backup)
        context.print(`Previous launcher kept at ${backup}`)
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error
      }
      await signalTurn()
      signal.throwIfAborted()
      context.print('Host uninstalled.')
      return 0
    } catch (error) {
      if (signal.aborted) return typeof signal.reason === 'number' ? signal.reason : 70
      context.print(
        error instanceof Error && error.message.startsWith('Install lock:')
          ? error.message
          : 'Host uninstall could not finish safely.',
      )
      return 75
    } finally {
      release?.()
    }
  })
}
