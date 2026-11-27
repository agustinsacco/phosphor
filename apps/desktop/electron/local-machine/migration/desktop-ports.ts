import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { createLaneArchiveStorage } from '@phosphor/session-runtime/lane-archive/storage'
import {
  isOwnerLockHolderLive,
  readOwnerLock,
} from '@phosphor/session-runtime/owner-lock/owner-lock'
import { listSandboxFolders } from '@phosphor/session-runtime/sandboxes/folders'
import { log } from '../../debug-log'
import { daemonRoots } from '../../daemon/roots'
import { listWorktrees } from '../../fs/git-worktrees'
import { retainedWorkspaces } from '../../maintenance/conversations'
import {
  listSessions,
  piAgentDir,
  piSessionsRoot,
  readSavedTranscript,
} from '../../pi/session-scanner'
import { prefs } from '../../prefs/backend'
import { routinesFileName } from '../../routines'
import { sandboxBase } from '../../sandbox-service'
import { getClaudeAccountPrefs, getPrefs } from '../../store'
import { e2eDaemonHook } from '../e2e-daemon'
import { decideLocalRuntimeMode, type LocalDaemonAccess } from '../mode'
import { ownerKeyAccess } from '../owner-key-access'
import { localDaemonLocation } from '../transport'
import type { CrashSide } from './commit'
import type { GatePorts } from './gate'
import { MIGRATION_DIR, migrationPermit, type MigrationStep } from './journal'
import { openOwnerChannel, type OwnerChannel } from './owner-channel'
import type { PostCommitSteps } from './post-commit'
import { scanPlanFacts } from './scan'
import { recordedFeatures } from './service-record'
import { fileVerifyPorts } from './verify'

/**
 * The launch gate's ports in Desktop main: real userData, pi's folders,
 * Desktop's own scanners and the service's install roots. Every location
 * comes from Electron or M1's roots, which a packaged app alone reads; an
 * unpackaged build reaches a service only through E1's gated e2e hook.
 */

/** Unpackaged and permitted only: `<step>:<before|after>` ends the process there (E2E crash cases). */
export const MIGRATION_CRASH_ENV = 'PHOSPHOR_MIGRATION_CRASH_AT'

const realpath = (path: string): string | null => {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/** Desktop's own access to its installed service: M1's roots and its sealed owner key. */
function serviceLocation() {
  if (!app.isPackaged) return null
  const roots = daemonRoots({
    isPackaged: true,
    env: process.env,
    home: homedir(),
    platform: process.platform,
    arch: process.arch,
  })
  const local = localDaemonLocation({
    isPackaged: true,
    env: process.env,
    home: homedir(),
    roots,
  })
  return local.on ? local.location : null
}

/** Canonical installed location, also available when the service is not running. */
export function installedBrainStateDirectory(): string | undefined {
  const location = serviceLocation()
  return location?.kind === 'service' ? location.stateDir : undefined
}

function serviceAccess(): LocalDaemonAccess | null {
  const location = serviceLocation()
  if (!location) return null
  return {
    location,
    ownerKey: async () => {
      const result = await ownerKeyAccess.get()
      if (!result.ok) throw new Error(result.reason)
      return result.key
    },
  }
}

/** Where daemon mode points when no service can be reached: a scratch-free path that never answers. */
function unreachableAccess(userData: string): LocalDaemonAccess {
  const dir = join(userData, MIGRATION_DIR, 'no-service')
  return {
    location: { kind: 'dev', socket: join(dir, 'none.sock'), configDir: dir },
    ownerKey: () => Promise.reject(new Error('This Mac’s Phosphor service is not reachable.')),
  }
}

function crashHook(
  permitted: boolean,
): ((step: MigrationStep, side: CrashSide) => void) | undefined {
  const value = process.env[MIGRATION_CRASH_ENV]
  if (app.isPackaged || !permitted || !value) return undefined
  return (step, side) => {
    if (value !== `${step}:${side}`) return
    log('migration', 'e2e crash', { step, side })
    process.kill(process.pid, 'SIGKILL')
  }
}

/** Claude accounts are their own pref, which getPrefs() never returns: the plan needs both. */
function migrationPrefs() {
  return { ...getPrefs(), claudeAccounts: getClaudeAccountPrefs() }
}

function legacyKeys(): boolean {
  const p = getPrefs()
  return p.recentWorkspaces.length > 0 || p.pinnedSessions.length > 0 || !!p.lastSessionPath
}

async function readLock(): Promise<'free' | 'daemon'> {
  const holder = await readOwnerLock(piAgentDir())
  return holder?.owner === 'daemon' && (await isOwnerLockHolderLive(holder)) ? 'daemon' : 'free'
}

/** The gate's owner channel to This Mac's service, for the break-glass restore. */
export function openServiceChannel(): Promise<OwnerChannel | null> {
  const hook = e2eDaemonHook()
  const access = hook.on ? hook.access : serviceAccess()
  return access ? openOwnerChannel({ ...access, uid: process.getuid?.() }) : Promise.resolve(null)
}

export function desktopGatePorts(postCommit: PostCommitSteps): GatePorts {
  const userData = app.getPath('userData')
  const permit = migrationPermit({ isPackaged: app.isPackaged, env: process.env })
  const hook = e2eDaemonHook()
  const lanes = createLaneArchiveStorage(join(userData, 'lane-archive'), piSessionsRoot())
  return {
    migrationDir: join(userData, MIGRATION_DIR),
    permit,
    packaged: app.isPackaged,
    readLock,
    legacyKeys,
    localRuntime: () => !!prefs().get('localRuntime'),
    recordedFeatures: () =>
      recordedFeatures({
        userData,
        isPackaged: app.isPackaged,
        migrationPermitted: permit.allowed,
        env: process.env,
      }),
    access: hook.on ? hook.access : serviceAccess(),
    unreachable: unreachableAccess(userData),
    e2eDaemon: hook.on,
    openChannel: (access) => openOwnerChannel({ ...access, uid: process.getuid?.() }),
    decide: (mode, access) =>
      mode === 'daemon'
        ? decideLocalRuntimeMode('daemon', access)
        : decideLocalRuntimeMode('in-app'),
    runner: {
      userData,
      migrationDir: join(userData, MIGRATION_DIR),
      now: Date.now,
      newId: randomUUID,
      desktopVersion: app.getVersion(),
      routinesFile: routinesFileName(),
      scan: ({ migrationId, machineId, backupDir, routinesCopy }) =>
        scanPlanFacts({
          migrationId,
          machineId,
          userData,
          backupDir,
          prefs: migrationPrefs(),
          sandboxBase: sandboxBase(),
          sandboxes: () => listSandboxFolders(sandboxBase()),
          realpath,
          listSessions,
          listWorktrees,
          retainedWorkspaces,
          archives: async () => (await lanes.list()).entries,
          exists: existsSync,
          size: (path) => statSync(path, { throwIfNoEntry: false })?.size ?? 0,
          routinesCopy,
        }),
      archives: async () => (await lanes.list()).entries,
      verify: {
        ...fileVerifyPorts,
        readTranscript: readSavedTranscript,
        exists: existsSync,
        accounts: () => getClaudeAccountPrefs().accounts.length,
      },
      desktop: { agentDir: piAgentDir(), sessionsRoot: piSessionsRoot() },
      postCommit,
      writeLocalRuntime: (value) => prefs().set('localRuntime', value),
      log: (event, data) => log('migration', event, data),
      crash: crashHook(permit.allowed),
    },
  }
}
