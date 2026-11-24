import type { Context, Hono } from 'hono'
import {
  CONTROL_ROUTES,
  CONTROL_LIMITS,
  HOST_HEADERS,
  isUuid,
  parseHeartbeatRequest,
  parseHeartbeatResponse,
  parseHostRevocations,
  type HeartbeatResponse,
  type HostRevocations,
} from '@phosphor/shared/control-api'
import { GRANT_LIMITS } from '@phosphor/shared/host-grant'
import type { TraceEvents } from '../events'
import type { AppDeps } from '../app'
import type { HostAuthDeps } from '../auth/host'
import { ControlFailure, type Env } from '../http'
import { body, host, outcome, parsed, record } from './shared'

/** What `control_machine_beat` answers: the owner's reach switch and revoked principals. */
export interface MachineBeat {
  readonly machineReach: boolean
  readonly revoked: readonly string[]
}

/** At most this many principals per beat, as `control_machine_beat` lists them. */
const MACHINE_REVOKED_MAX = 40

export function parseMachineBeat(value: unknown): MachineBeat | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const beat = value as Record<string, unknown>
  if (beat.outcome !== 'ok' || typeof beat.machineReach !== 'boolean') return null
  if (!Array.isArray(beat.revoked) || beat.revoked.length > MACHINE_REVOKED_MAX) return null
  if (!beat.revoked.every(isUuid)) return null
  return { machineReach: beat.machineReach, revoked: beat.revoked }
}

/**
 * The reply's revocation fields from whichever of the two lookups answered. Client
 * revocations come first and are never displaced: principal ids fill what is left of
 * the 100-entry list. With only the machine lookup, `ownerId` and `epoch` stay absent;
 * a Host never clears a revocation it already holds, so a partial list is safe.
 */
export function mergeRevocations(
  revocations: HostRevocations | undefined,
  machine: MachineBeat | undefined,
): Partial<HeartbeatResponse> {
  if (!machine) return { ...revocations }
  const clients = [...(revocations?.revoked.clients ?? [])]
  const seen = new Set(clients)
  for (const id of machine.revoked) {
    if (clients.length >= GRANT_LIMITS.revocations) break
    if (!seen.has(id)) clients.push(id)
    seen.add(id)
  }
  return {
    ...revocations,
    revoked: { sessions: revocations?.revoked.sessions ?? [], clients },
    machineReach: machine.machineReach,
  }
}

function reason(error: unknown) {
  return error instanceof ControlFailure ? error.code : 'unavailable'
}

async function lookups(
  c: Context<Env>,
  deps: AppDeps,
  events: TraceEvents,
  id: string,
  machineGrants: boolean | undefined,
) {
  const [v1, machine] = await Promise.allSettled([
    deps.supabase.rpc('control_host_revocations', { p_host: id }),
    deps.supabase.rpc('control_machine_beat', {
      p_host: id,
      p_machine_grants: machineGrants ?? null,
    }),
  ])
  let revocations: HostRevocations | undefined
  try {
    if (v1.status === 'rejected') throw v1.reason
    revocations = parsed(parseHostRevocations(v1.value))
  } catch (error) {
    events.emit(c, 'heartbeat.revocations_unavailable', { hostId: id, reason: reason(error) })
  }
  const beat = machine.status === 'fulfilled' ? parseMachineBeat(machine.value) : null
  if (!beat)
    events.emit(c, 'heartbeat.machine_unavailable', {
      hostId: id,
      reason: machine.status === 'rejected' ? reason(machine.reason) : 'unavailable',
    })
  return mergeRevocations(revocations, beat ?? undefined)
}

/**
 * The v1 heartbeat and revocation calls are made exactly as before. The machine beat
 * runs beside the revocation lookup and is best effort: when it fails, the reply omits
 * the machine fields and the beat is still accepted.
 */
export function heartbeat(app: Hono<Env>, deps: AppDeps, auth: HostAuthDeps, events: TraceEvents) {
  app.post(CONTROL_ROUTES.hostHeartbeat, async (c) => {
    const input = parsed(parseHeartbeatRequest(body(c)), 'bad-request')
    try {
      const id = await host(c, auth, 'host')
      const value = record(
        await deps.supabase.rpc('control_host_heartbeat', {
          p_host_id: id,
          p_seq: input.seq,
          p_state: input.state,
          p_host_version: input.hostVersion,
          p_uptime_sec: input.uptimeSec,
          p_readiness: input.readiness,
          p_running: input.lanes.running,
          p_waiting: input.lanes.waiting,
          p_endpoint: input.endpoint,
        }),
      )
      outcome(value, 'accepted')
      events.accepted(c, id, input)
      const revocations = await lookups(c, deps, events, id, input.machineGrants)
      return c.json(
        parsed(
          parseHeartbeatResponse({
            accepted: true,
            nextInSec: CONTROL_LIMITS.heartbeatSec,
            ...revocations,
          }),
        ),
      )
    } catch (error) {
      const hostId = c.req.header(HOST_HEADERS.host)
      if (error instanceof ControlFailure && error.code === 'gone' && isUuid(hostId))
        events.emit(c, 'host.refused', { hostId, reason: 'gone' })
      throw error
    }
  })
}
