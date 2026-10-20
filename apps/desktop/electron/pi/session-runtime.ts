import { registry } from '../registry'
import { access } from 'node:fs/promises'
import { decideSession, recordWorkspaceIntent, withWorkspace } from '../maintenance/history'
import { createSessionStartup } from '@phosphor/session-runtime/pi/session-startup'
import { createSessionService } from '@phosphor/session-runtime/pi/session-service'
import { sessionPaths } from './session-path-lock'
import { piStubPath } from './stub'
import type { SessionExecution } from '@phosphor/session-runtime/pi/session-policy'
import { desktopSessionSink } from './session-events'
import { prepareDesktopSessionLaunch } from './session-launch'
import { desktopSessionPolicy } from './session-policy'
import { holdAccount } from '../claude/accounts'
import { forgetSpawnAccount, rememberSpawnAccount } from './session-accounts'
import { watchContextBudget, withBudgetCompaction } from './context-budget'
import {
  isRoutineSession,
  routineSessionForPath,
  observeRoutineSession,
} from '../routines/ownership'
import { getPrefs, recordWorkspace, realPathOrNull } from '../store'
import type { CreateSessionOptions, LiveSessionInfo } from '@shared/models'
import { log } from '../debug-log'
import { createLaneReload } from '@phosphor/session-runtime/pi/lane-reload'
import { createLaneConfigFingerprint } from './lane-config'

/** MCP and package config changes reach running lanes before their next turn. */
const laneReload = createLaneReload({
  fingerprint: createLaneConfigFingerprint(),
  log,
  // A reload can change the lane's commands (MCP prompts are commands).
  onApplied: () => {
    void import('./catalogue').then((m) => m.invalidatePiCommands())
  },
})

const spawn = createSessionStartup({
  registry,
  resolveWorkspace: realPathOrNull,
  launch: prepareDesktopSessionLaunch,
  policy: desktopSessionPolicy,
  log,
  budget: {
    watch: watchContextBudget,
    read: () => getPrefs().contextBudget,
    paused: isRoutineSession,
  },
  accounts: { remember: rememberSpawnAccount, forget: forgetSpawnAccount, hold: holdAccount },
  recordWorkspace,
  laneReload,
})

const service = createSessionService<Electron.WebContents>({
  registry,
  paths: sessionPaths,
  spawn: (options, target, execution = {}) =>
    spawn(
      options,
      (id) => desktopSessionSink(id, target, () => execution.unattended ?? false),
      execution,
    ),
  isStub: () => Boolean(piStubPath()),
  packages: desktopSessionPolicy.packages,
  readBudget: () => getPrefs().contextBudget,
  withBudgetCompaction,
  forgetAccount: forgetSpawnAccount,
  laneReload,
  routines: {
    owns: isRoutineSession,
    sessionForPath: routineSessionForPath,
    observe: observeRoutineSession,
    cancel: async (id) => {
      const { cancelRoutineSession } = await import('../routines')
      await cancelRoutineSession(id)
    },
  },
})

export const desktopSessions = {
  ...service,
  create: (
    options: CreateSessionOptions,
    target?: Electron.WebContents,
    execution: SessionExecution = {},
  ) => {
    // Record intent before queueing behind a sweep. A resumed conversation is unfinished.
    recordWorkspaceIntent(options.workspacePath)
    if (options.sessionPath) decideSession(options.sessionPath, false)
    return withWorkspace(options.workspacePath, async () => {
      await access(options.workspacePath)
      return service.create(options, target, execution)
    })
  },
}

/** Both IPC and routines enter the same process-local admission boundary. */
export function spawnSession(
  options: CreateSessionOptions,
  target?: Electron.WebContents,
  execution: SessionExecution = {},
): Promise<LiveSessionInfo> {
  return desktopSessions.create(options, target, execution)
}
