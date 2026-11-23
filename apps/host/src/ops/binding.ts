import type { DatabaseSync } from 'node:sqlite'
import type { LaneSummary, ReadyOpFlag } from '@phosphor/shared/host-protocol'
import { OP_CATALOG, OP_GAPS } from '@phosphor/shared/ops-catalog'
import { remoteLaneKey, type HostCapability } from '@phosphor/shared/remote-host'
import type { RpcCommand } from '@phosphor/shared/rpc'
import { deferredRpcCommand } from '@phosphor/session-runtime/ops/deferred-rpc'
import type { SurfacePrincipal } from '@phosphor/session-runtime/ops/ports'
import type {
  LaneDeferred,
  LaneFacts,
  OpHandler,
  OpHandlerResult,
  OpPrincipal,
  OpsBinding,
} from '@phosphor/session-runtime/ops/types'
import type { CatalogSpec } from '@phosphor/shared/ops-catalog'

/**
 * A surface principal on a Host connection, carrying the capabilities that
 * connection holds, so the dispatcher's capability check reads this request's
 * own grant and never another connection's.
 */
export interface HostSurfacePrincipal extends SurfacePrincipal {
  readonly caps: readonly HostCapability[]
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
  const { caps: _caps, ...shown } = principal
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

export interface DaemonBindingPorts {
  readonly account?: (sessionId: string, accountId: string) => Promise<void>
  /** Every id this machine answers to: the enrolled Host id and the local machine id. */
  readonly selfIds: () => readonly string[]
  readonly lanes: DaemonLanes
  /** `state.sqlite`, for `lane_prefs`. */
  readonly db: DatabaseSync
  readonly command: (
    sessionId: string,
    rpc: RpcCommand,
  ) => Promise<{ success: boolean; error?: string }>
}

const LANE_REF = /^host:([^/]+)\/lane:([^/]+)$/

/** `host:<self>/lane:<laneId>` for either of this machine's ids, or a bare lane id. */
export function laneIdOf(ref: string, selfIds: readonly string[]): string | null {
  const match = LANE_REF.exec(ref)
  if (!match) return ref
  return selfIds.includes(match[1]!) || (selfIds.length === 0 && match[1] === 'local')
    ? match[2]!
    : null
}

/** The lane id in a ref this machine resolved (`LaneFacts.ref`, an agent's `laneRef`), or a bare id. */
export function laneIdInRef(ref: string): string {
  return LANE_REF.exec(ref)?.[2] ?? ref
}

/** The ref this machine writes for its own lane: under the enrolled id when there is one. */
export function laneRefFor(selfIds: readonly string[], laneId: string): string {
  return remoteLaneKey(selfIds[0] ?? 'local', laneId)
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
        const row = ports.db
          .prepare(`SELECT value FROM lane_prefs WHERE lane_id=? AND key='lineage'`)
          .get(laneId)
        const lineage = Number(row?.value)
        return Number.isSafeInteger(lineage) && lineage >= 0 ? { lineage } : null
      },
    },
    deferred: {
      async apply(sessionId, items: readonly LaneDeferred[]) {
        for (const item of items) {
          if (item.action) {
            // The settle event reaches this contribution and the lane projection in the same tick.
            await Promise.resolve().then(item.action)
            continue
          }
          if (item.kind === 'account' && ports.account) {
            await ports.account(sessionId, item.accountId)
            continue
          }
          const rpc = deferredRpcCommand(item)
          if (!rpc) return { ok: false, message: `This machine cannot apply ${item.kind} yet.` }
          const result = await ports.command(sessionId, rpc)
          if (!result.success)
            return { ok: false, message: result.error ?? 'pi refused this command.' }
        }
        return { ok: true }
      },
    },
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
    const creator = p.kind === 'machine' ? p.machineId : (lane ?? p.kind)
    db.prepare(
      "INSERT OR REPLACE INTO lane_prefs(lane_id,key,value) VALUES (?,'created_by',?),(?,'lineage',?)",
    ).run(id, creator, id, String(1 + Math.max(depth, p.kind === 'agent' ? p.lineage : 0)))
  }
}
