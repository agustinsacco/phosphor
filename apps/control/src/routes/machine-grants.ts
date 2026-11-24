import type { Context, Hono } from 'hono'
import {
  CONTROL_MACHINE_ROUTES,
  isUuid,
  parseClientRegisterResponse,
  parseGrantIssueResponse,
  parseMachineDirectoryResponse,
  parseMachineGrantIssueRequest,
} from '@phosphor/shared/control-api'
import type { AppDeps } from '../app'
import type { HostAuthDeps } from '../auth/host'
import type { TraceEvents } from '../events'
import { ControlFailure, type Env } from '../http'
import { machineGrantClaims } from './machine-grant-claims'
import { body, host, outcome, parsed, record } from './shared'

/** Per caller machine, after the signature: on top of the per-IP `machine-auth` budget. */
const MACHINE_LIMITS = {
  directory: { purpose: 'machine-directory', limit: 30, windowMs: 60_000 },
  issue: { purpose: 'machine-grant-issue', limit: 60, windowMs: 60_000 },
} as const

async function caller(
  c: Context<Env>,
  deps: AppDeps,
  auth: HostAuthDeps,
  kind: keyof typeof MACHINE_LIMITS,
): Promise<string> {
  const id = await host(c, auth, 'host', 'machine-auth')
  const { purpose, limit, windowMs } = MACHINE_LIMITS[kind]
  if (!deps.limits.consume(`${purpose}:${id}`, limit, windowMs))
    throw new ControlFailure('too-many-requests')
  return id
}

/** Outcomes the shared mapping does not know; anything else would fall to 503. */
function issueOutcome(value: Record<string, unknown>): void {
  if (value.outcome === 'reach-off') throw new ControlFailure('forbidden')
  if (value.outcome === 'target-unavailable') throw new ControlFailure('conflict')
  outcome(value, 'issued')
}

function validEpoch(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2147483647
  )
}

/**
 * Host-signed machine reach: the caller's sibling directory and a grant to one sibling.
 * Registered from `hosts()` so `createApp` stays within its size ceiling.
 */
export function machineGrants(
  app: Hono<Env>,
  deps: AppDeps,
  auth: HostAuthDeps,
  events: TraceEvents,
) {
  app.get(CONTROL_MACHINE_ROUTES.hostMachines, async (c) => {
    const id = await caller(c, deps, auth, 'directory')
    const value = record(await deps.supabase.rpc('control_machine_directory', { p_host: id }))
    outcome(value, 'ok')
    return c.json(parsed(parseMachineDirectoryResponse(value)))
  })
  app.post(CONTROL_MACHINE_ROUTES.hostMachineGrants, async (c) => {
    const keys = deps.config.grantKeys
    if (!keys) throw new ControlFailure('unavailable')
    const input = parsed(parseMachineGrantIssueRequest(body(c)), 'bad-request')
    const id = await caller(c, deps, auth, 'issue')
    const value = record(
      await deps.supabase.rpc('control_machine_grant_issue', {
        p_caller: id,
        p_target: input.targetHostId,
      }),
    )
    issueOutcome(value)
    // Validate database metadata before putting it in a signed payload.
    if (!validEpoch(value.epoch) || !isUuid(value.ownerId) || !isUuid(value.sid))
      throw new ControlFailure('unavailable')
    const { client } = parsed(parseClientRegisterResponse(value))
    const payload = machineGrantClaims({
      origin: deps.config.publicOrigin,
      kid: keys.kid,
      ownerId: value.ownerId,
      sid: value.sid,
      targetHostId: input.targetHostId,
      callerHostId: id,
      epoch: value.epoch,
      client,
      iat: Math.floor(deps.clock() / 1000),
      jti: Buffer.from(deps.random(8)).toString('hex'),
    })
    const result = parsed(
      parseGrantIssueResponse({
        grant: keys.sign(payload),
        expiresAt: new Date(payload.exp * 1000).toISOString(),
        host: { id: input.targetHostId, endpoint: value.endpoint, publicKey: value.publicKey },
      }),
    )
    events.emit(c, 'machine.grant_issued', {
      hostId: id,
      targetHostId: input.targetHostId,
      clientId: client.id,
      jti: payload.jti,
      exp: payload.exp,
    })
    return c.json(result)
  })
}
