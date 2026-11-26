import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import type { HostReleaseFeature } from '@phosphor/shared/host-release'
import type { ReadyOpFlag } from '@phosphor/shared/host-protocol'
import { parseOpArgv } from '@phosphor/shared/ops-cli'
import { OP_CATALOG, OP_GAPS } from '@phosphor/shared/ops-catalog'
import type { ExtensionUIResponse } from '@phosphor/shared/rpc'
import { AGENT_OPS_SCHEMA, createAuditLog } from '@phosphor/session-runtime/ops/audit'
import { confirmPort, createConfirmStore } from '@phosphor/session-runtime/ops/confirm'
import { createOpsDispatcher } from '@phosphor/session-runtime/ops/dispatcher'
import { createJobStore } from '@phosphor/session-runtime/ops/jobs'
import { archiveSelection } from './handlers/archives'
import { laneJob } from './handlers/lanes'
import { recordCreator } from './binding'
import { laneRefFor } from './lane-ref'
import { argsSummary } from '@phosphor/session-runtime/ops/redact'
import { createUndo } from '@phosphor/session-runtime/ops/undo'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { OpsDispatcherDeps } from '@phosphor/session-runtime/ops/ports'
import type { OpsBinding, OpsDispatcher } from '@phosphor/session-runtime/ops/types'
import { HOST_SIDECARS, parseLocalIdentityFile } from '@phosphor/shared/host-local'
import type { LaneSummary } from '@phosphor/shared/host-protocol'
import { readSidecar } from '../config/sidecar'
import type { LaneCommandClient } from '../lanes/commands/state'
import type { OpsAdapterPorts } from './adapter'
import { loadSqlite } from '../lanes/sqlite'
import { prepareStateFile } from '../lanes/state-dir'
import {
  daemonLaneBinding,
  servedFlags,
  surfaceAdmits,
  type DaemonBindingPorts,
  type DaemonLanes,
  type DeferredActions,
} from './binding'
import { daemonUndoChecks } from './undo-current'
import { domainHandlers, type DaemonHandlerDeps } from './handlers'
import { resourceJobSpec } from './handlers/resources-call'
import { daemonMetaHandlers } from './handlers/meta'
import { createPolicyFile } from './policy-file'
import { createHostResolver } from './remote'

export interface OpsServicePorts extends Omit<DaemonHandlerDeps, 'log' | 'recordCreator' | 'db'> {
  /** The Host state folder: `state.sqlite` and `agent-policy.json`. */
  readonly stateDirectory: string
  readonly uid: number | undefined
  readonly selfIds: DaemonBindingPorts['selfIds']
  /** The enrolled Host id, or null before enrollment: confirm items name it (N4). */
  readonly enrolledId: () => string | null
  readonly daemonLanes: DaemonLanes
  readonly command: DaemonBindingPorts['command']
  /** Deferred owner actions: reload, stop and archive. */
  readonly deferredActions?: DeferredActions
  /** A routine run with no one watching: its asked ops answer `unattended`. */
  readonly unattended: (sessionId: string) => boolean
  readonly remote?: OpsBinding['remote']
  readonly log: RuntimeLog
  /** How `whoami` names this machine; the host name when absent. */
  readonly machine?: string
  readonly now?: () => number
}

export interface OpsService {
  readonly dispatcher: OpsDispatcher
  /** What `ready` announces on both listeners. */
  readonly readyFlags: ReadonlySet<ReadyOpFlag>
  /** A lane dialog answer: relayed, or refused when it would approve an op confirm from a non-surface. */
  dialogGuard(
    laneId: string,
    response: ExtensionUIResponse,
    client: Pick<LaneCommandClient, 'origin'>,
  ): 'relay' | 'forbidden'
  /**
   * Sends whether the policy lets other machines' agents act here (X2's
   * machine-grant opt-in) now and after every policy change. A later target
   * replaces the earlier one: each control connection has its own authority.
   */
  bindMachineOps(target: (enabled: boolean) => void): void
  /** The agent-control switch for a new lane: off leaves out the `phosphor` tool. */
  agentControl(): Promise<boolean>
  close(): void
}

/** A second connection to `state.sqlite` beside the lane store's, as the audit's home. */
async function openStateDatabase(directory: string, uid: number | undefined) {
  const sqlite = await loadSqlite()
  const db: DatabaseSync = new sqlite.DatabaseSync(prepareStateFile(directory, uid))
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;')
    db.exec(AGENT_OPS_SCHEMA)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/**
 * Agent control on this Host: the dispatcher over the daemon's binding, its
 * policy file, the audit and jobs in `state.sqlite`, and the in-memory
 * confirmations. Bound on every Host with lanes; machine grants stay off
 * unless the policy lets other machines in.
 */
export async function createOpsService(ports: OpsServicePorts): Promise<OpsService> {
  const now = ports.now ?? Date.now
  const db = await openStateDatabase(ports.stateDirectory, ports.uid)
  try {
    return bindOps(ports, db, now)
  } catch (error) {
    db.close()
    throw error
  }
}

/** The service's stores: audit, confirmations, jobs, the policy file, and what follows a policy change. */
function opsStores(ports: OpsServicePorts, db: DatabaseSync, now: () => number) {
  const { log } = ports
  const audit = createAuditLog(db)
  const confirms = createConfirmStore()
  const jobs = createJobStore(db, { now, newId: randomUUID, log })
  const policy = createPolicyFile({
    directory: ports.stateDirectory,
    uid: ports.uid,
    db,
    now,
    log: (event, fields) => log('ops', event, fields),
  })
  let machineTarget: ((enabled: boolean) => void) | undefined
  const sendMachineOps = () => {
    const target = machineTarget
    if (!target) return
    policy.read().then(
      ({ policy: current }) => target(current.machineOps !== 'off'),
      (error: unknown) => log('ops', 'policy read failed', { error: String(error) }),
    )
  }
  // Surfaces poll (N5); the log line is the record. A policy change also moves the machine opt-in.
  const notify: OpsBinding['notifySurfaces'] = (event) => {
    log('ops', 'changed', { kind: event.kind })
    if (event.kind === 'policy') sendMachineOps()
  }
  const changed = () => notify({ kind: 'confirm' })
  return {
    audit,
    confirms,
    jobs,
    policy,
    notify,
    changed,
    bindMachineOps(target: (enabled: boolean) => void) {
      machineTarget = target
      sendMachineOps()
    },
  }
}

/** The agent principal for a live session of one of this machine's lanes. */
function daemonAgentFor(
  ports: OpsServicePorts,
  createdBy: OpsBinding['lanes']['createdBy'],
): OpsDispatcherDeps['agentFor'] {
  return (sessionId) => {
    const lanes = ports.daemonLanes
    const lane = lanes.list().find((l) => lanes.sessionFor(l.laneId) === sessionId)
    if (!lane) return null
    const laneRef = laneRefFor(ports.selfIds(), lane.laneId)
    return {
      kind: 'agent',
      sessionId,
      laneRef,
      lineage: createdBy(laneRef)?.lineage ?? 0,
      unattended: ports.unattended(sessionId),
    }
  }
}

function settledAccountMove(ports: OpsServicePorts) {
  return async (sessionId: string, accountId: string) => {
    const id = ports.daemonLanes
      .list()
      .find((l) => ports.daemonLanes.sessionFor(l.laneId) === sessionId)?.laneId
    if (!id || !ports.settingsOps) throw new Error('No live lane to move.')
    await ports.settingsOps.moveClaudeAccount(id, accountId, () => true)
  }
}

// Daemon-only jobs: the catalog stays frozen; these may run past 20 s here.
const DAEMON_CATALOG = OP_CATALOG.map((s) =>
  s.name === 'package.checkUpdates' ? { ...s, job: true as const } : resourceJobSpec(s),
)

/** The dispatcher's view of this machine: its handlers, gaps, policy, audit and lanes. */
function daemonBinding(
  ports: OpsServicePorts,
  parts: Pick<OpsBinding, 'handlers' | 'policy' | 'audit' | 'notifySurfaces'>,
  laneBinding: ReturnType<typeof daemonLaneBinding>,
): OpsBinding {
  const { handlers } = parts
  return {
    ...parts,
    // Read per use: a local daemon may enroll while it runs.
    get machineId() {
      return ports.enrolledId()
    },
    gaps: OP_GAPS.daemon,
    flags: servedFlags(handlers),
    ...laneBinding,
    ...(ports.remote ? { remote: ports.remote } : {}),
  }
}

function bindOps(ports: OpsServicePorts, db: DatabaseSync, now: () => number): OpsService {
  const { log } = ports
  const { audit, confirms, jobs, policy, notify, changed, bindMachineOps } = opsStores(
    ports,
    db,
    now,
  )
  const domain = { ...ports, db, recordCreator: recordCreator(db, ports) }
  const inverseRequests = new WeakSet<object>()
  const handlers = {
    ...domainHandlers(domain),
    ...daemonMetaHandlers({
      machine: ports.machine ?? hostname(),
      audit,
      confirms,
      changed,
      policy,
      notify,
      undo: (principal, id) => dispatcher.undo(principal, id),
      jobs,
    }),
  }
  const laneBinding = daemonLaneBinding({
    selfIds: ports.selfIds,
    lanes: ports.daemonLanes,
    db,
    command: ports.command,
    account: settledAccountMove(ports),
    ...(ports.deferredActions ? { actions: ports.deferredActions } : {}),
  })
  const binding = daemonBinding(
    ports,
    { handlers, policy, audit, notifySurfaces: notify },
    laneBinding,
  )
  const dispatcher = createOpsDispatcher(binding, {
    catalog: DAEMON_CATALOG,
    parseArgv: (argv, content) => parseOpArgv(argv, undefined, { content }),
    agentFor: daemonAgentFor(ports, laneBinding.lanes.createdBy),
    surfaceAdmits,
    confirms: confirmPort(confirms, changed),
    redact: argsSummary,
    background: (r, self) => !inverseRequests.has(r) && laneJob(r.op, self),
    archiveIds: () => archiveSelection(domain),
    undo: { run: (principal, id) => undo(principal, id) },
    jobs: jobs.port,
    ...(ports.directory
      ? { hosts: createHostResolver({ directory: ports.directory, selfIds: ports.selfIds }) }
      : {}),
    log,
    now,
  })
  const undo = createUndo({
    audit,
    isCurrent: daemonUndoChecks(domain, laneBinding.lanes.resolve),
    run: (principal, request) => {
      inverseRequests.add(request)
      return dispatcher.run(principal, request)
    },
  })
  return {
    dispatcher,
    readyFlags: binding.flags,
    dialogGuard(laneId, response, client) {
      const sessionId = ports.daemonLanes.sessionFor(laneId)
      if (!sessionId) return 'relay'
      return dispatcher.surfaceAnswered(sessionId, response, client.origin ?? 'surface')
    },
    bindMachineOps,
    agentControl: async () => (await policy.read()).policy.agentControl !== 'off',
    close() {
      ports.machineUpdate?.stop()
      jobs.close()
      db.close()
    },
  }
}

/** What run hands agent control once the machine's lane service exists. */
export interface RunOpsPorts extends Pick<
  OpsServicePorts,
  | 'routines'
  | 'repositories'
  | 'appServices'
  | 'skills'
  | 'ownerFolders'
  | 'sandboxes'
  | 'stateDirectory'
  | 'sessionsRoot'
  | 'uid'
  | 'store'
  | 'lanes'
  | 'management'
  | 'settingsOps'
  | 'shellEnvironment'
  | 'machineHealth'
  | 'editing'
  | 'enrolledId'
  | 'remote'
  | 'directory'
  | 'deferredActions'
  | 'laneRuntime'
  | 'writes'
  | 'serviceUpdate'
  | 'pauseState'
  | 'pauseControl'
  | 'machineUpdate'
  | 'log'
  | 'now'
> {
  /** Run's one ops slot, which both listeners read. */
  readonly slot: OpsAdapterPorts
  /** Beside `config.json`: a local daemon's `local-identity.json` names its local machine id. */
  readonly configDirectory: string
  readonly live: {
    summaryFor(laneId: string): LaneSummary | null
    sessionFor(laneId: string): string | null
  }
  readonly command: OpsServicePorts['command']
  /** The sessions the lanes' op channel saw spawned unattended. */
  readonly unattended: ReadonlySet<string>
}

/** Binds the dispatcher into run's slot, so both listeners and every lane's op channel serve it. */
export async function startRunOps(ports: RunOpsPorts): Promise<OpsService> {
  const local = readSidecar(
    ports.configDirectory,
    HOST_SIDECARS.localIdentity,
    parseLocalIdentityFile,
    { uid: ports.uid },
  )
  const localId = local.state === 'ok' ? local.value.machineId : null
  const { store, live } = ports
  const service = await createOpsService({
    ...ports,
    selfIds: () => [ports.enrolledId(), localId].filter((id): id is string => id !== null),
    daemonLanes: {
      list: () => store.listLanes().flatMap((lane) => live.summaryFor(lane.laneId) ?? []),
      summary: (laneId) => live.summaryFor(laneId),
      sessionFor: (laneId) => live.sessionFor(laneId),
    },
    unattended: (sessionId) => ports.unattended.has(sessionId),
  })
  ports.slot.dispatcher = service.dispatcher
  ports.slot.readyFlags = service.readyFlags
  return service
}

/** What this service adds to `phosphor version --json`. */
export const FEATURE: HostReleaseFeature | null = 'ops'
