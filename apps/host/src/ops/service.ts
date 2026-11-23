import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import type { HostReleaseFeature } from '@phosphor/shared/host-release'
import type { ReadyOpFlag } from '@phosphor/shared/host-protocol'
import { parseOpArgv } from '@phosphor/shared/ops-cli'
import { OP_GAPS } from '@phosphor/shared/ops-catalog'
import type { ExtensionUIResponse } from '@phosphor/shared/rpc'
import { AGENT_OPS_SCHEMA, createAuditLog } from '@phosphor/session-runtime/ops/audit'
import { confirmPort, createConfirmStore } from '@phosphor/session-runtime/ops/confirm'
import { createOpsDispatcher } from '@phosphor/session-runtime/ops/dispatcher'
import { createJobStore } from '@phosphor/session-runtime/ops/jobs'
import { argsSummary } from '@phosphor/session-runtime/ops/redact'
import { createUndo } from '@phosphor/session-runtime/ops/undo'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
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
  laneRefFor,
  servedFlags,
  surfaceAdmits,
  type DaemonBindingPorts,
  type DaemonLanes,
} from './binding'
import { domainHandlers, type DaemonHandlerDeps } from './handlers'
import { daemonMetaHandlers } from './handlers/meta'
import { createPolicyFile } from './policy-file'

export interface OpsServicePorts extends Omit<DaemonHandlerDeps, 'log'> {
  /** The Host state folder: `state.sqlite` and `agent-policy.json`. */
  readonly stateDirectory: string
  readonly uid: number | undefined
  readonly selfIds: DaemonBindingPorts['selfIds']
  /** The enrolled Host id, or null before enrollment: confirm items name it (N4). */
  readonly enrolledId: () => string | null
  readonly daemonLanes: DaemonLanes
  readonly command: DaemonBindingPorts['command']
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

function bindOps(ports: OpsServicePorts, db: DatabaseSync, now: () => number): OpsService {
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
  const handlers = {
    ...domainHandlers(ports),
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
  })
  const binding: OpsBinding = {
    // Read per use: a local daemon may enroll while it runs.
    get machineId() {
      return ports.enrolledId()
    },
    handlers,
    gaps: OP_GAPS.daemon,
    flags: servedFlags(handlers),
    policy,
    audit,
    ...laneBinding,
    ...(ports.remote ? { remote: ports.remote } : {}),
    notifySurfaces: notify,
  }
  const dispatcher = createOpsDispatcher(binding, {
    parseArgv: (argv, content) => parseOpArgv(argv, undefined, { content }),
    agentFor(sessionId) {
      const lane = ports.daemonLanes
        .list()
        .find((l) => ports.daemonLanes.sessionFor(l.laneId) === sessionId)
      if (!lane) return null
      const laneRef = laneRefFor(ports.selfIds(), lane.laneId)
      return {
        kind: 'agent',
        sessionId,
        laneRef,
        lineage: laneBinding.lanes.createdBy(laneRef)?.lineage ?? 0,
        unattended: ports.unattended(sessionId),
      }
    },
    surfaceAdmits,
    confirms: confirmPort(confirms, changed),
    redact: argsSummary,
    // No daemon op records an inverse yet, so a stored one never counts as current.
    undo: { run: (principal, id) => undo(principal, id) },
    jobs: jobs.port,
    log,
    now,
  })
  const undo = createUndo({
    audit,
    isCurrent: async () => false,
    run: (principal, request) => dispatcher.run(principal, request),
  })
  return {
    dispatcher,
    readyFlags: binding.flags,
    dialogGuard(laneId, response, client) {
      const sessionId = ports.daemonLanes.sessionFor(laneId)
      if (!sessionId) return 'relay'
      return dispatcher.surfaceAnswered(sessionId, response, client.origin ?? 'surface')
    },
    bindMachineOps(target) {
      machineTarget = target
      sendMachineOps()
    },
    agentControl: async () => (await policy.read()).policy.agentControl !== 'off',
    close() {
      jobs.close()
      db.close()
    },
  }
}

/** What run hands agent control once the machine's lane service exists. */
export interface RunOpsPorts extends Pick<
  OpsServicePorts,
  | 'stateDirectory'
  | 'uid'
  | 'store'
  | 'lanes'
  | 'shellEnvironment'
  | 'enrolledId'
  | 'remote'
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

/** What this service adds to `phosphor version --json`. Announced by the lead with local mode, not here. */
export const FEATURE: HostReleaseFeature | null = null
