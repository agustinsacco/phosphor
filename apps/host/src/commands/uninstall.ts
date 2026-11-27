import { lstatSync, readlinkSync, readdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultConfigPath } from '../config/load'
import { hostConfigDirectory, hostStateDirectory } from '@phosphor/shared/host-local'
import { LOCAL_BRAIN_OWNER_FILE } from '@phosphor/session-runtime/brain/local-owner'
import { isOwnerPrivate } from '@phosphor/session-runtime/fs-safety'
import { SERVICE_LOG_NAMES } from './setup-local-service'
import { requiresBrainCompatibility } from '@phosphor/session-runtime/host-install/brain-compatibility'
import { checkedFolder } from '@phosphor/session-runtime/host-install/files'
import { acquireInstallLock, hasCode } from '@phosphor/session-runtime/host-install/lock'
import {
  commandLayout,
  hostInstallRoot,
  type InstalledLayout,
} from '@phosphor/session-runtime/host-install/layout'
import { checkBrainPurge } from '../update/purge-brain'
import { HOST_BRAIN_WRITER_LOCK } from '../brain/writer-lock'
import {
  checkPurgeWriterLock,
  HOST_BRAIN_WRITER_GATE,
  holdPurgeWriterLock,
  WRITER_REPAIR,
} from '../update/purge-writer-lock'
import { installLifetime, signalTurn } from '../update/lifetime'
import { removeHostPathBlocks } from '../machine/shell-path'
import { runLogout } from './logout'
import { runService } from './service'
import { serviceState, type UpdateContext } from './update'

const BRAIN_UNINSTALL_REFUSED =
  'Host uninstall refused: signed qualified Brain repair is not proven. The release, launcher and state were kept.'

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
  'lane-archive',
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
  'agent-policy.json',
  'claude-accounts.json',
  'claude-accounts',
  'owner-migration',
  'sandboxes',
  'web-push.json',
  'brain',
  'brain-handover',
  HOST_BRAIN_WRITER_LOCK,
  LOCAL_BRAIN_OWNER_FILE,
])
function requirePrivateFolder(path: string, uid: number | undefined) {
  const info = lstatSync(path)
  if (!info.isDirectory() || !isOwnerPrivate(info, uid))
    throw new Error('State is not a private folder; nothing in this folder will be purged.')
}
function checkedEntries(state: string, uid: number | undefined) {
  requirePrivateFolder(state, uid)
  const entries = readdirSync(state)
  // An interrupted writer-lock reclamation: its gate is kept and the owner is told how to repair.
  if (entries.includes(HOST_BRAIN_WRITER_GATE)) throw new Error(WRITER_REPAIR)
  if (entries.some((name) => !stateEntries.has(name)))
    throw new Error('State contains unknown entries; nothing in this folder will be purged.')
  if (entries.some((name) => lstatSync(join(state, name)).isSymbolicLink()))
    throw new Error('State contains unsafe links; nothing in this folder will be purged.')
  if (entries.includes('logs')) {
    const logs = join(state, 'logs')
    requirePrivateFolder(logs, uid)
    if (
      readdirSync(logs).some(
        (name) => !SERVICE_LOG_NAMES.includes(name) || !lstatSync(join(logs, name)).isFile(),
      )
    )
      throw new Error('State contains unknown entries; nothing in this folder will be purged.')
  }
  checkBrainPurge(state, uid, entries)
  return entries
}
/** Every check, the writer lock's included; changes nothing. */
async function checkedState(state: string, uid: number | undefined): Promise<void> {
  checkedEntries(state, uid)
  await checkPurgeWriterLock(state, uid)
}
/** Purges while holding the Brain's writer lock, so no Host process writes the Brain meanwhile. */
async function purgeState(state: string, uid: number | undefined) {
  const writer = await holdPurgeWriterLock(state, uid)
  try {
    for (const name of checkedEntries(state, uid)) {
      const path = join(state, name)
      // The lock is the purge's own now; only its release removes it, by token.
      if (name === HOST_BRAIN_WRITER_LOCK) continue
      if (name === 'logs') {
        for (const file of SERVICE_LOG_NAMES) rmSync(join(path, file), { force: true })
        rmdirSync(path)
      } else rmSync(path, { recursive: true })
    }
  } finally {
    await writer.release()
  }
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
      const installed = () =>
        commandLayout(context.home, context.update?.node, context.update?.bundle)
      const layout = installed()
      const config = hostConfigDirectory(context.env, context.home)
      const state = hostStateDirectory(context.env, context.home)
      const safe = (path: string) => checkedFolder(path, path, context.home, context.uid)
      // Even a source or stale command cannot bypass the lock and protection of the shared install.
      const lib = hostInstallRoot(context.home)
      if (safe(lib)) {
        release = acquireInstallLock(lib)
        if (installed()?.version !== layout?.version)
          throw new Error('Install changed; retry uninstall.')
        if (requiresBrainCompatibility(lib, context.home, state)) {
          context.print(BRAIN_UNINSTALL_REFUSED)
          return 75
        }
      } else if (layout) throw new Error('Install changed; retry uninstall.')
      if (purge) {
        safe(config)
        const hasState = safe(state)
        if (context.configPath !== defaultConfigPath(context.env, context.home)) {
          context.print('Purge requires the default config path.')
          return 64
        }
        if (hasState) await checkedState(state, context.uid)
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
      if (purge && safe(state)) await checkedState(state, context.uid)
      if (layout) removeRelease(context, layout)
      else
        context.print(
          `Source install: remove the bundle folder ${dirname(context.update?.bundle ?? process.argv[1] ?? 'phosphor.mjs')}.`,
        )
      removeHostPathBlocks(context.home, context.uid)
      if (purge) {
        if (safe(state)) await purgeState(state, context.uid)
        if (safe(config)) rmSync(config, { recursive: true })
      } else context.print(`Kept config and identity: ${config}; state: ${state}`)
      if (layout) {
        release?.()
        release = undefined
        removeEmptyInstall(layout.lib)
      }
      reportBackup(context)
      await signalTurn()
      signal.throwIfAborted()
      context.print('Host uninstalled.')
      return 0
    } catch (error) {
      if (signal.aborted) return typeof signal.reason === 'number' ? signal.reason : 70
      context.print(
        error instanceof Error &&
          /^(Install lock:|Install changed;|State contains (?:unknown entries|unsafe links);|State is not a private folder;|Brain (?:state|move|writer lock) )/.test(
            error.message,
          )
          ? error.message
          : 'Host uninstall could not finish safely.',
      )
      return 75
    } finally {
      release?.()
    }
  })
}

/** Remove this unprotected release and its own launcher. Caller holds the install lock. */
function removeRelease(context: UpdateContext, layout: InstalledLayout): void {
  const { home, uid } = context
  checkedFolder(layout.lib, layout.lib, home, uid)
  const bin = join(home, '.local/bin')
  checkedFolder(bin, bin, home, uid)
  const launcher = join(bin, 'phosphor')
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
    if (name !== '.install-lock') rmSync(join(layout.lib, name), { recursive: true, force: true })
}

function removeEmptyInstall(lib: string): void {
  // A new installer can win after release. Never remove its lock or program.
  try {
    rmdirSync(lib)
  } catch (error) {
    if (!hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EEXIST')) throw error
  }
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
