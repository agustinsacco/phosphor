import type { Hono } from 'hono'
import {
  CONTROL_ROUTES,
  CONTROL_LIMITS,
  isPublicKey,
  parseHostSelfResponse,
  parseHeartbeatRequest,
  parseHeartbeatResponse,
} from '@phosphor/shared/control-api'
import type { AppDeps } from '../app'
import type { HostAuthDeps } from '../auth/host'
import { ControlFailure, type Env } from '../http'
import { body, emptyBody, host, outcome, parsed, record } from './shared'

export function hostAuthentication(deps: AppDeps): HostAuthDeps {
  return {
    clock: deps.clock,
    nonces: deps.nonces,
    limits: deps.limits,
    hostKey: async (id) => {
      const value = record(await deps.supabase.rpc('control_host_key', { p_host_id: id }))
      if (value.outcome === 'gone') return 'gone'
      outcome(value, 'active')
      if (!isPublicKey(value.publicKey)) throw new ControlFailure('unavailable')
      return value.publicKey
    },
  }
}
export function hosts(app: Hono<Env>, deps: AppDeps, auth: HostAuthDeps) {
  app.get(CONTROL_ROUTES.hostSelf, async (c) => {
    const id = await host(c, auth, 'host')
    const value = record(await deps.supabase.rpc('control_host_self', { p_host_id: id }))
    outcome(value, 'active')
    return c.json(parsed(parseHostSelfResponse(value)))
  })
  app.post(CONTROL_ROUTES.hostHeartbeat, async (c) => {
    const input = parsed(parseHeartbeatRequest(body(c)), 'bad-request')
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
    return c.json(
      parsed(parseHeartbeatResponse({ accepted: true, nextInSec: CONTROL_LIMITS.heartbeatSec })),
    )
  })
  app.post(CONTROL_ROUTES.hostRevoke, async (c) => {
    emptyBody(c)
    const id = await host(c, auth, 'host')
    const value = record(await deps.supabase.rpc('control_host_revoke_self', { p_host_id: id }))
    outcome(value, 'revoked')
    return c.body(null, 204)
  })
}
