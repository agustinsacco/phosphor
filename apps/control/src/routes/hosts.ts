import type { Hono } from 'hono'
import { CONTROL_ROUTES, isPublicKey, parseHostSelfResponse } from '@phosphor/shared/control-api'
import type { TraceEvents } from '../events'
import type { AppDeps } from '../app'
import type { HostAuthDeps } from '../auth/host'
import { ControlFailure, type Env } from '../http'
import { emptyBody, host, outcome, parsed, record } from './shared'
import { heartbeat } from './heartbeat'
import { machineGrants } from './machine-grants'

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
export function hosts(app: Hono<Env>, deps: AppDeps, auth: HostAuthDeps, events: TraceEvents) {
  app.get(CONTROL_ROUTES.hostSelf, async (c) => {
    const id = await host(c, auth, 'host')
    const value = record(await deps.supabase.rpc('control_host_self', { p_host_id: id }))
    outcome(value, 'active')
    return c.json(parsed(parseHostSelfResponse(value)))
  })
  heartbeat(app, deps, auth, events)
  machineGrants(app, deps, auth, events)
  app.post(CONTROL_ROUTES.hostRevoke, async (c) => {
    emptyBody(c)
    const id = await host(c, auth, 'host')
    const value = record(await deps.supabase.rpc('control_host_revoke_self', { p_host_id: id }))
    outcome(value, 'revoked')
    events.removed(c, id)
    return c.body(null, 204)
  })
}
