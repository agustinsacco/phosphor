import { OPS_UNREADABLE } from '@phosphor/host-client/ops'
import { openHostSocket } from '@phosphor/host-client/socket'
import type { FrameSocket } from '@phosphor/shared/host-protocol'
import {
  parseOpsRunResult,
  type OpsDenyCode,
  type OpsRunResult,
} from '@phosphor/shared/host-protocol-ops'
import type { HostReleaseFeature } from '@phosphor/shared/host-release'
import { OP_CATALOG, type CatalogSpec } from '@phosphor/shared/ops-catalog'
import type {
  Reach,
  ReachMachine,
  ReachResult,
  ReachUnavailable,
} from '@phosphor/session-runtime/ops/reach'
import type { OpsBinding } from '@phosphor/session-runtime/ops/types'
import { createReachDirectory } from './directory'
import { CONTROL_STAGE_TEXT, type ReachControlPorts } from './control'
import { createReachGrants } from './grants'
import { createReachPool, type ReachPoolLimits } from './pool'

/** Machine reach: other enrolled machines asking this one, and this one asking them. Not built yet: null. */
export function createReach(): null {
  return null
}

/** What this service adds to `phosphor version --json`: machine reach through control's grants. */
export const FEATURE: HostReleaseFeature | null = 'machine-grants'

export interface MachineReachPorts extends ReachControlPorts {
  /** Opens a sibling's `/v1/stream`; the tailnet WebSocket unless a test injects one. */
  readonly socket?: (url: string) => Promise<FrameSocket>
  /** The `.ts.net` endpoint rule unless a test injects one. */
  readonly endpointAllowed?: (value: unknown) => boolean
  readonly limits?: Partial<ReachPoolLimits>
}

type Failure = Extract<ReachResult, { ok: false }>
const refused = (code: Failure['code'], message: string): Failure => ({ ok: false, code, message })

/** Why no other machine is reachable at all, as `--host` and `hosts.list` say it. */
export const DIRECTORY_REFUSALS: Readonly<Record<ReachUnavailable, Failure>> = {
  'signed-out': refused(
    'forbidden',
    'This machine is not enrolled, so it cannot reach other machines.',
  ),
  'control-old': refused(
    'unsupported',
    "Other machines are unavailable: Phosphor's control service does not offer machine reach yet.",
  ),
  'control-unreachable': refused('offline', CONTROL_STAGE_TEXT['control-unreachable']),
  'control-timeout': refused('timeout', CONTROL_STAGE_TEXT['control-timeout']),
  'rate-limited': refused('denied', CONTROL_STAGE_TEXT['rate-limited']),
  'bad-response': refused('offline', CONTROL_STAGE_TEXT['bad-response']),
  'reach-off': refused(
    'forbidden',
    'Machine reach is off on this machine. Turn it on under Machines.',
  ),
  'account-disabled': refused(
    'forbidden',
    'Your Phosphor account is disabled, so other machines are unavailable.',
  ),
}

function notReady(machine: ReachMachine): Failure {
  if (machine.why === 'reach-off')
    return refused(
      'forbidden',
      `Machine reach is off on ${machine.label}. Turn it on under Machines.`,
    )
  if (machine.why === 'not-enrolled')
    return refused(
      'unsupported',
      `${machine.label} is not enrolled for reach. Update that Host and enable machine reach.`,
    )
  if (machine.why === 'stale-heartbeat')
    return refused('offline', `${machine.label} has a stale heartbeat. Check that Host is running.`)
  return refused('offline', `${machine.label} is offline.`)
}

/** The daemon's `Reach`: control's directory and grants, then a sibling connection per target. */
export function createMachineReach(ports: MachineReachPorts): Reach {
  const directory = createReachDirectory(ports)
  const grants = createReachGrants(ports)
  const log = ports.log ?? (() => {})
  const pool = createReachPool({
    grants,
    socket: ports.socket ?? ((url) => openHostSocket(url, log)),
    endpointAllowed: ports.endpointAllowed,
    now: ports.now,
    log: ports.log,
    limits: ports.limits,
  })
  return {
    async directory(options) {
      const listing = await directory.read(options)
      if (!listing.available) return listing
      return {
        ...listing,
        machines: listing.machines.map((m) => ({ ...m, ...pool.capabilities(m.id) })),
      }
    },
    async run(hostId, request, options) {
      let machine = options.target?.id === hostId ? options.target : undefined
      if (!machine) {
        const listing = await directory.read(options)
        if (!listing.available) return DIRECTORY_REFUSALS[listing.reason]
        if (hostId === listing.self.id) return refused('bad-request', 'That is this machine.')
        machine = listing.machines.find((entry) => entry.id === hostId)
      }
      if (!machine) return refused('bad-request', 'No machine on your account has that id.')
      if (!machine.ready) return notReady(machine)
      return pool.run(machine, request, options)
    },
    close() {
      pool.close()
      grants.clear()
      directory.clear()
      return Promise.resolve()
    },
  }
}

const DENY_CODES: Record<Failure['code'], OpsDenyCode> = {
  unsupported: 'unsupported',
  forbidden: 'forbidden',
  offline: 'unavailable',
  timeout: 'unavailable',
  unconfirmed: 'unavailable',
  'too-large': 'too-large',
  'bad-request': 'bad-request',
  'needs-confirm': 'unavailable',
  denied: 'limit',
}

/** A reach result as the dispatcher reads it: the target's own answer when it gave one. */
export function reachOpsResult(result: ReachResult): OpsRunResult {
  const answer = 'data' in result ? parseOpsRunResult(result.data) : null
  if (answer) return answer
  if (result.ok) return { status: 'denied', code: 'unavailable', text: OPS_UNREADABLE }
  return { status: 'denied', code: DENY_CODES[result.code], text: result.message }
}

/**
 * A1's `binding.remote` over `Reach`. `write` comes from the op's catalog tier
 * on another machine (never this lane): anything but `read`. An op the catalog
 * does not know is refused here and never sent.
 */
export function reachRemote(
  reach: Pick<Reach, 'run'>,
  catalog: readonly CatalogSpec[] = OP_CATALOG,
): NonNullable<OpsBinding['remote']> {
  return {
    async run(hostId, request, options) {
      const spec = catalog.find((entry) => entry.name === request.op)
      if (!spec)
        return { status: 'denied', code: 'bad-request', text: `Unknown operation: ${request.op}.` }
      const tier =
        typeof spec.tier === 'function' ? spec.tier(request.args, { self: false }) : spec.tier
      return reachOpsResult(
        await reach.run(hostId, request, {
          write: tier !== 'read',
          signal: options.signal,
          deadlineAt: options.deadlineAt,
          ...(options.target ? { target: options.target } : {}),
        }),
      )
    },
  }
}
