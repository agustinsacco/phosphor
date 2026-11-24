import type { Hono } from 'hono'
import {
  CONTROL_ROUTES,
  CONTROL_LIMITS,
  isPublicKey,
  isUuid,
  HOST_HEADERS,
  parseHostSelfResponse,
  parseHeartbeatRequest,
  parseHeartbeatResponse,
  parseHostRevocations,
  type HostRevocations,
} from '@phosphor/shared/control-api'
import type { TraceEvents } from '../events'
import type { AppDeps } from '../app'
import type { HostAuthDeps } from '../auth/host'
import { ControlFailure, type Env } from '../http'
import { body, emptyBody, host, outcome, parsed, record } from './shared'

/**
 * withinSkew accepts both ends of its window, so one signed request stays valid for
 * twice the skew inclusive. A claim must outlive that whole span plus a margin, or a
 * request first seen at the early edge is accepted again at the late edge.
 */
const NONCE_TTL_SEC = 2 * CONTROL_LIMITS.signatureSkewSec + 1
export function hostAuthentication(deps: AppDeps): HostAuthDeps {
  return {
    clock: deps.clock,
    limits: deps.limits,
    // Postgres holds the claims, so a replay fails across restarts and replicas. Key
    // mode claims under the public key and host mode under the host id: they never collide.
    claimNonce: async (identity, nonce) => {
      const value = record(
        await deps.supabase.rpc('control_nonce_claim', {
          p_identity: identity,
          p_nonce: nonce,
          p_ttl_sec: NONCE_TTL_SEC,
        }),
      )
      if (value.outcome === 'replayed') return false
      if (value.outcome !== 'claimed') throw new ControlFailure('unavailable')
      return true
    },
    hostKey: async (id) => {
      const value = record(await deps.supabase.rpc('control_host_key', { p_host_id: id }))
      if (value.outcome === 'gone') return 'gone'
      outcome(value, 'active')
      if (!isPublicKey(value.publicKey)) throw new ControlFailure('unavailable')
      return value.publicKey
    },
  }
}
export function hosts(app: Hono<Env>, deps: AppDeps, auth: HostAuthDeps, events: TraceEvents) {
  app.get(CONTROL_ROUTES.hostSelf, async (c) => {
    const id = await host(c, auth, 'host')
    const value = record(await deps.supabase.rpc('control_host_self', { p_host_id: id }))
    outcome(value, 'active')
    return c.json(parsed(parseHostSelfResponse(value)))
  })
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
      let revocations: HostRevocations | undefined
      try {
        revocations = parsed(
          parseHostRevocations(await deps.supabase.rpc('control_host_revocations', { p_host: id })),
        )
      } catch (error) {
        events.emit(c, 'heartbeat.revocations_unavailable', {
          hostId: id,
          reason: error instanceof ControlFailure ? error.code : 'unavailable',
        })
      }
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
  app.post(CONTROL_ROUTES.hostRevoke, async (c) => {
    emptyBody(c)
    const id = await host(c, auth, 'host')
    const value = record(await deps.supabase.rpc('control_host_revoke_self', { p_host_id: id }))
    outcome(value, 'revoked')
    events.removed(c, id)
    return c.body(null, 204)
  })
}
