import type { MachineUpdateReport } from '@phosphor/shared/machine-update'
import type { WorkspaceLeases } from '../../owner/lease'
import type { AppServices } from '../../session/app-services'
import { createBrainHandlers } from './brain'
import type { SettingsOps } from './settings-access'
import type { RepositorySummary } from '@phosphor/shared/host-protocol'
import type { createRepositories } from '../../features/repositories'
import type { HostRoutines } from '../../routines/service'
import type { SkillPorts } from './skills'
import type { createHostSandboxes } from '../../features/sandboxes'
import { sandboxHandlers } from './sandboxes'
import type { DatabaseSync } from 'node:sqlite'
import type { HostShellEnvironment } from '../../machine/shell-environment'
import type { LaneEditingRuntime } from '../../lanes/editing'
import type { LaneService } from '../../lanes/service'
import type { HostStore } from '../../lanes/store'
import type { AuditEntry, UndoRecord } from '@phosphor/session-runtime/ops/audit'
import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { Reach } from '@phosphor/session-runtime/ops/reach'
import type { LaneHandlerPorts } from './lane-ports'
import type { ServicePauseState } from '@phosphor/shared/host-protocol-owner'
import type { ServiceUpdatePorts } from '../service-update'
import { archiveHandlers } from './archives'
import { artifactRemoveHandlers } from './artifact-remove'
import { artifactHandlers } from './artifacts'
import { configHandlers } from './config'
import { fileHandlers, type DaemonFileWrites } from './files'
import { folderHandlers } from './folders'
import { gitHandlers } from './git'
import { hostsHandlers } from './hosts'
import { laneEditingHandlers, laneEditingUndoChecks } from './lane-editing'
import { laneSelfHandlers } from './lane-self'
import type { DaemonLaneRuntime } from './lane-target'
import { laneHandlers } from './lanes'
import { machineHandlers } from './machine'
import { mcpHandlers } from './mcp'
import { packageHandlers } from './packages'
import { routineHandlers } from './routines'
import { settingsHandlers } from './settings'
import { skillHandlers } from './skills'

/** What the daemon's domain handlers wrap: its existing services, never copies of them. */
export interface DaemonHandlerDeps extends LaneHandlerPorts {
  readonly appServices?: AppServices | null
  readonly settingsOps?: SettingsOps
  readonly workspaceLeases?: WorkspaceLeases
  readonly ownerFolders?: () => readonly RepositorySummary[]
  readonly repositories?: Pick<ReturnType<typeof createRepositories>, 'execute'>
  readonly routines?: Pick<HostRoutines, 'execute'> &
    Partial<Pick<HostRoutines, 'sessionPathForRun'>>
  readonly skills?: SkillPorts
  readonly sandboxes?: ReturnType<typeof createHostSandboxes>
  readonly store: HostStore
  /** The lane service `ops.run` sits beside: commands, calls and topics. */
  readonly lanes: LaneService
  /** The login-shell capture on a local-mode daemon; null on a headless Host. */
  readonly shellEnvironment: HostShellEnvironment | null
  readonly machineHealth?: () => { pi: string; control: string }
  /** Control's machine directory (X3 reach); absent: this machine reaches no other. */
  readonly directory?: Reach['directory']
  readonly log: RuntimeLog
  /** `state.sqlite` beside the lane store's connection: `lane_prefs`. */
  readonly db: DatabaseSync
  /** The Host state folder; its `artifacts` store has one writer, this daemon. */
  readonly stateDirectory?: string
  readonly sessionsRoot?: string
  /** The runtime's path lock and the lanes topic, for lane editing. */
  readonly editing: LaneEditingRuntime
  /** The lane runtime beside the lane service: lane commands, connectors, summaries. */
  readonly laneRuntime?: DaemonLaneRuntime
  /** The Host's file writes in lane folders. */
  readonly writes?: DaemonFileWrites
  /** The service's own updater and lane pause; absent on a source install. */
  readonly serviceUpdate?: ServiceUpdatePorts
  /** The service pause, for `machine.status`. */
  readonly pauseState?: () => ServicePauseState
  readonly pauseControl?: (action: 'abort-now' | 'cancel') => boolean
  /** `machine.status` `data.update`: the release self-check and the last result; stopped on close. */
  readonly machineUpdate?: {
    report(): Omit<MachineUpdateReport, 'pauseControl'>
    stop(): void
  }
}

/** Every domain file's handlers. Meta ops come from `meta.ts`, bound over the dispatcher's stores. */
export function domainHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  return {
    ...createBrainHandlers(deps.appServices),
    ...laneHandlers(deps),
    ...archiveHandlers(deps),
    ...artifactHandlers(deps),
    ...artifactRemoveHandlers(deps),
    ...settingsHandlers(deps),
    ...mcpHandlers(deps),
    ...packageHandlers(deps),
    ...configHandlers(deps),
    ...skillHandlers(deps),
    ...routineHandlers(deps),
    ...folderHandlers(deps),
    ...sandboxHandlers(deps),
    ...laneSelfHandlers(deps),
    ...laneEditingHandlers(deps),
    ...machineHandlers(deps),
    ...fileHandlers(deps),
    ...gitHandlers(deps),
    ...hostsHandlers(deps),
  }
}

/**
 * Undo's precondition for one op: the state its change left is still in
 * place. `before` is the inverse's args, `forward` the change's own args when
 * the audit kept them. An op without a check never counts as current.
 */
export type DaemonUndoCheck = (
  before: unknown,
  deps: DaemonHandlerDeps,
  forward?: Readonly<Record<string, unknown>>,
) => boolean | Promise<boolean>

const UNDO_CHECKS: Readonly<Record<string, DaemonUndoCheck>> = {
  ...laneEditingUndoChecks,
}

/** Whether an op has a check in this table. */
export const hasDaemonUndoCheck = (op: string) => Object.hasOwn(UNDO_CHECKS, op)

/** Whether an audited change can still be undone without overwriting a newer one. */
export async function daemonUndoIsCurrent(
  entry: AuditEntry & { readonly undoRecord: UndoRecord },
  deps: DaemonHandlerDeps,
): Promise<boolean> {
  const check = Object.hasOwn(UNDO_CHECKS, entry.op) ? UNDO_CHECKS[entry.op] : undefined
  return check ? await check(entry.undoRecord.inverse.args, deps, entry.undoRecord.forward) : false
}

/**
 * Catalog ops the daemon serves once their package lands, by package and
 * handler file. Until then the dispatcher answers them `unsupported`, and a
 * `ready` flag whose ops are pending is not announced. Every catalog op now
 * has a daemon handler or a documented gap (`OP_GAPS.daemon`).
 */
const PENDING: Readonly<Record<string, string>> = {}

export interface PendingHandler {
  readonly package: string
  /** Under `apps/host/src/ops/handlers/`. */
  readonly file: string
}

export const PENDING_HANDLERS: Readonly<Record<string, PendingHandler>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PENDING).flatMap(([owner, ops]) => {
      const [pkg = '', file = ''] = owner.split(' ')
      return ops.split(' ').map((name) => [name, { package: pkg, file }])
    }),
  ),
)
