import type { DatabaseSync } from 'node:sqlite'
import type { LaneSummary, ReadyOpFlag } from '@phosphor/shared/host-protocol'
import { OP_CATALOG, OP_GAPS } from '@phosphor/shared/ops-catalog'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { RpcCommand } from '@phosphor/shared/rpc'
import { authenticatedLane } from '@phosphor/session-runtime/ops/principals'
import { deferredRpcCommand } from '@phosphor/session-runtime/ops/deferred-rpc'
import type { SurfacePrincipal } from '@phosphor/session-runtime/ops/ports'
import type {
  DeferredOutcome,
  LaneDeferred,
  LaneFacts,
  OpHandler,
  OpHandlerResult,
  OpPrincipal,
  OpsBinding,
} from '@phosphor/session-runtime/ops/types'
import type { CatalogSpec } from '@phosphor/shared/ops-catalog'
import { laneIdOf, laneRefFor } from './lane-ref'

/**
 * A surface principal on a Host connection, carrying the capabilities that
 * connection holds, so the dispatcher's capability check reads this request's
 * own grant and never another connection's.
 */
export interface HostSurfacePrincipal extends SurfacePrincipal {
  readonly caps: readonly HostCapability[]
  readonly currentCaps?: () => readonly HostCapability[]
}

export function hasCaps(principal: SurfacePrincipal): principal is HostSurfacePrincipal {
  return Array.isArray((principal as Partial<HostSurfacePrincipal>).caps)
}

/** Whether this surface's own connection holds what the op requires. A principal without caps is refused. */
export function surfaceAdmits(
  principal: SurfacePrincipal,
  requires: NonNullable<CatalogSpec['requires']>,
): boolean {
  if (!hasCaps(principal)) return false
  const caps = principal.caps
  if (!(requires.caps ?? []).every((cap) => caps.includes(cap))) return false
  return requires.configure !== true || caps.includes('machine.configure')
}

/** What `whoami` shows: the principal, without the connection's capability list. */
export function shownPrincipal(principal: OpPrincipal): OpPrincipal {
  if (principal.kind !== 'surface' || !hasCaps(principal)) return principal
  const { caps: _caps, currentCaps: _currentCaps, ...shown } = principal
  return shown
}

/**
 * The `ready` flags this Host announces: `ops` once a dispatcher is bound, and
 * a feature flag only when every op that needs it has a handler here.
 */
export function servedFlags(handlers: Readonly<Record<string, OpHandler>>): Set<ReadyOpFlag> {
  const flags = new Set<ReadyOpFlag>(['ops'])
  const needed = new Map<ReadyOpFlag, boolean>()
  for (const spec of OP_CATALOG) {
    if (!spec.flag || OP_GAPS.daemon[spec.name]) continue
    needed.set(spec.flag, (needed.get(spec.flag) ?? true) && Object.hasOwn(handlers, spec.name))
  }
  for (const [flag, served] of needed) if (served) flags.add(flag)
  return flags
}

/** The daemon's lanes as ops see them. */
export interface DaemonLanes {
  list(): readonly LaneSummary[]
  summary(laneId: string): LaneSummary | null
  sessionFor(laneId: string): string | null
}

/** Where a settled run's deferred work lands. */
export interface DeferredTarget {
  /** The lane, when the session is one of this machine's lanes. */
  readonly laneId: string | null
  /** The lane's live session now: an earlier model change may have replaced the process. */
  readonly sessionId: string
  /** The session whose run settled, which held the work. */
  readonly settledSessionId: string
}

/** Deferred work that is an owner action rather than one pi command. */
export type DeferredActionKind = Extract<LaneDeferred['kind'], 'reload' | 'stop' | 'archive'>

export type DeferredActions = {
  readonly [K in DeferredActionKind]?: (
    item: Extract<LaneDeferred, { kind: K }>,
    target: DeferredTarget,
  ) => Promise<DeferredOutcome>
}

export interface DaemonBindingPorts {
  readonly account?: (sessionId: string, accountId: string) => Promise<void>
  /** Every id this machine answers to: the enrolled Host id and the local machine id. */
  readonly selfIds: () => readonly string[]
  readonly lanes: DaemonLanes
  /** `state.sqlite`, for `lane_prefs`. */
  readonly db: DatabaseSync
  /** A lane command through the lane runtime, so a model change may replace the process. */
  readonly command: (
    sessionId: string,
    rpc: RpcCommand,
  ) => Promise<{ success: boolean; error?: string }>
  /** Reload, stop and archive; a kind without an action answers that it cannot apply yet. */
  readonly actions?: DeferredActions
}

function runAction(
  actions: DeferredActions | undefined,
  item: LaneDeferred,
  target: DeferredTarget,
): Promise<DeferredOutcome> | null {
  switch (item.kind) {
    case 'reload':
      return actions?.reload?.(item, target) ?? null
    case 'stop':
      return actions?.stop?.(item, target) ?? null
    case 'archive':
      return actions?.archive?.(item, target) ?? null
    default:
      return null
  }
}

/**
 * One settled run's work, in order, each item on the lane's session at that
 * moment: a model change that replaces the process leaves the rest for the
 * new one.
 */
async function applyDeferred(
  ports: DaemonBindingPorts,
  settledSessionId: string,
  items: readonly LaneDeferred[],
): Promise<DeferredOutcome> {
  const lanes = ports.lanes
  const laneId =
    lanes.list().find((lane) => lanes.sessionFor(lane.laneId) === settledSessionId)?.laneId ?? null
  for (const item of items) {
    const sessionId = (laneId !== null ? lanes.sessionFor(laneId) : null) ?? settledSessionId
    if (item.action) {
      // H1's owner actions (stop, archive) carry their own work; the settle event
      // reaches this contribution and the lane projection in the same tick.
      await Promise.resolve().then(item.action)
      continue
    }
    if (item.kind === 'account' && ports.account) {
      await ports.account(sessionId, item.accountId)
      continue
    }
    const rpc = deferredRpcCommand(item)
    if (rpc) {
      const result = await ports.command(sessionId, rpc)
      if (!result.success) return { ok: false, message: result.error ?? 'pi refused this command.' }
      continue
    }
    const action = runAction(ports.actions, item, { laneId, sessionId, settledSessionId })
    if (!action) return { ok: false, message: `This machine cannot apply ${item.kind} yet.` }
    const outcome = await action
    if (!outcome.ok) return outcome
  }
  return { ok: true }
}

export function laneFacts(
  ports: Pick<DaemonBindingPorts, 'selfIds' | 'lanes'>,
  lane: LaneSummary,
): LaneFacts {
  const controller = lane.control.controller
  return {
    ref: laneRefFor(ports.selfIds(), lane.laneId),
    sessionId: ports.lanes.sessionFor(lane.laneId),
    title: lane.title ?? '',
    cwd: lane.cwd,
    activity: lane.activity,
    busy: lane.activity === 'working' || lane.activity === 'needs-input',
    controlFence: lane.control.fence,
    controller: controller ? { clientId: controller.clientId, label: controller.label } : null,
  }
}

/** Lane lookup, lineage and deferred lane work for the daemon's `OpsBinding`. */
export function daemonLaneBinding(
  ports: DaemonBindingPorts,
): Pick<OpsBinding, 'lanes' | 'deferred'> {
  const resolve = (ref: string) => {
    const laneId = laneIdOf(ref, ports.selfIds())
    const lane = laneId ? ports.lanes.summary(laneId) : null
    return lane ? laneFacts(ports, lane) : null
  }
  return {
    lanes: {
      resolve,
      createdBy(laneRef) {
        const laneId = laneIdOf(laneRef, ports.selfIds())
        if (!laneId) return null
        const rows = ports.db
          .prepare(
            "SELECT key, value FROM lane_prefs WHERE lane_id=? AND key IN ('lineage', 'created_by')",
          )
          .all(laneId)
        const lineage = Number(rows.find((row) => row.key === 'lineage')?.value)
        const creator = rows.find((row) => row.key === 'created_by')?.value
        return Number.isSafeInteger(lineage) && lineage >= 0
          ? { lineage, ...(typeof creator === 'string' ? { creator } : {}) }
          : null
      },
    },
    deferred: { apply: (sessionId, items) => applyDeferred(ports, sessionId, items) },
  }
}

/** Non-RPC owner actions run only after this lane’s own run settles, never on a replacement session. */
export function afterLaneSettles(
  item: LaneDeferred,
  laneId: string,
  sessionId: string,
  lanes: DaemonLanes,
  action: () => Promise<OpHandlerResult>,
): OpHandlerResult {
  return {
    text: `Scheduled ${item.kind} for ${laneId} after this run.`,
    undo: false,
    deferred: [
      {
        ...item,
        action: async () => {
          if (lanes.sessionFor(laneId) !== sessionId)
            throw new Error('The lane session changed before settle.')
          return action()
        },
      },
    ],
  }
}

export function recordCreator(db: DatabaseSync, ports: Pick<DaemonBindingPorts, 'selfIds'>) {
  return (id: string, p: OpPrincipal) => {
    if (p.kind === 'surface') return
    const lane = p.kind === 'agent' ? p.laneRef : p.lane
    const parent = lane ? laneIdOf(lane, ports.selfIds()) : null
    const depth = parent
      ? Number(
          db.prepare("SELECT value FROM lane_prefs WHERE lane_id=? AND key='lineage'").get(parent)
            ?.value ?? 0,
        )
      : 0
    const creator = authenticatedLane(p) ?? (p.kind === 'machine' ? p.machineId : p.kind)
    db.prepare(
      "INSERT OR REPLACE INTO lane_prefs(lane_id,key,value) VALUES (?,'created_by',?),(?,'lineage',?)",
    ).run(id, creator, id, String(1 + Math.max(depth, p.kind === 'agent' ? p.lineage : 0)))
  }
}
