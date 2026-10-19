import { parseWebClientsResponse } from '@phosphor/shared/web-auth'
import { effectiveAuthorization } from '../web/effective-token'
import type { Hono } from 'hono'
import {
  CONTROL_ROUTES,
  isUuid,
  parseClientRegisterRequest,
  parseClientRegisterResponse,
  parseGrantIssueRequest,
  parseGrantIssueResponse,
} from '@phosphor/shared/control-api'
import { grantClaims } from './grant-claims'
import { userGuard, type createUserAuth } from '../auth/user'
import type { AppDeps } from '../app'
import type { TraceEvents } from '../events'
import { ControlFailure, type Env } from '../http'
import { body, outcome, parsed, record } from './shared'

/** Called only after userGuard verified this exact access token. */
function sessionId(authorization: string | undefined): string {
  try {
    const part = authorization?.slice(7).split('.')[1]
    if (!part) throw new Error('missing payload')
    const payload = record(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')))
    if (isUuid(payload.session_id)) return payload.session_id
  } catch {
    // No token bytes or claims in the failure.
  }
  throw new ControlFailure('unauthenticated')
}

export function grants(
  app: Hono<Env>,
  deps: AppDeps,
  auth: ReturnType<typeof createUserAuth>,
  events: TraceEvents,
) {
  const guard = userGuard(auth, deps.supabase)
  app.get(CONTROL_ROUTES.clients, guard, async (c) => {
    return c.json(
      parsed(
        parseWebClientsResponse(
          await deps.supabase.rpc('control_web_clients_list', { p_user: c.get('user').userId }),
        ),
      ),
    )
  })
  app.post(CONTROL_ROUTES.clients, guard, async (c) => {
    if (c.get('webClientId')) throw new ControlFailure('forbidden')
    const input = parsed(parseClientRegisterRequest(body(c)), 'bad-request')
    const userId = c.get('user').userId
    if (!deps.limits.consume('client-register:' + userId, 10, 3_600_000))
      throw new ControlFailure('too-many-requests')
    const value = record(
      await deps.supabase.rpc('control_client_register', {
        p_user: userId,
        p_label: input.label,
        p_kind: 'desktop',
      }),
    )
    if (value.outcome === 'too-many-requests') throw new ControlFailure('too-many-requests')
    outcome(value, 'registered')
    const result = parsed(parseClientRegisterResponse(value))
    events.emit(c, 'client.registered', { userId, clientId: result.client.id })
    return c.json(result)
  })
  app.delete(CONTROL_ROUTES.clients + '/:id', guard, async (c) => {
    const clientId = c.req.param('id')
    if (!isUuid(clientId)) throw new ControlFailure('bad-request')
    const userId = c.get('user').userId
    const value = record(
      await deps.supabase.rpc('control_client_revoke', {
        p_user: userId,
        p_client: clientId,
      }),
    )
    outcome(value, 'revoked')
    events.emit(c, 'client.revoked', { userId, clientId })
    return c.body(null, 204)
  })
  app.post(CONTROL_ROUTES.grants, guard, async (c) => {
    const keys = deps.config.grantKeys
    if (!keys) throw new ControlFailure('unavailable')
    const input = parsed(parseGrantIssueRequest(body(c)), 'bad-request')
    if (c.get('webClientId') && input.clientId !== c.get('webClientId'))
      throw new ControlFailure('forbidden')
    const sid = sessionId(effectiveAuthorization(c))
    const userId = c.get('user').userId
    if (!deps.limits.consume('grant-issue:' + userId, 120, 60_000))
      throw new ControlFailure('too-many-requests')
    const value = record(
      await deps.supabase.rpc('control_grant_issue', {
        p_user: userId,
        p_host: input.hostId,
        p_client: input.clientId,
        p_sid: sid,
      }),
    )
    outcome(value, 'issued')
    // Validate database metadata before putting it in a signed payload.
    if (
      typeof value.epoch !== 'number' ||
      !Number.isSafeInteger(value.epoch) ||
      value.epoch < 1 ||
      value.epoch > 2147483647
    )
      throw new ControlFailure('unavailable')
    const { client } = parsed(parseClientRegisterResponse(value))
    if (client.id !== input.clientId) throw new ControlFailure('unavailable')
    const payload = grantClaims({
      origin: deps.config.publicOrigin,
      kid: keys.kid,
      userId,
      sid,
      hostId: input.hostId,
      epoch: value.epoch,
      client,
      configure: input.configure,
      iat: Math.floor(deps.clock() / 1000),
      jti: Buffer.from(deps.random(8)).toString('hex'),
    })
    const result = parsed(
      parseGrantIssueResponse({
        grant: keys.sign(payload),
        expiresAt: new Date(payload.exp * 1000).toISOString(),
        host: { id: input.hostId, endpoint: value.endpoint, publicKey: value.publicKey },
      }),
    )
    events.emit(c, 'grant.issued', {
      userId,
      hostId: input.hostId,
      clientId: client.id,
      jti: payload.jti,
      exp: payload.exp,
    })
    return c.json(result)
  })
  app.get(CONTROL_ROUTES.grantKeys, (c) => {
    if (!deps.config.grantKeys) throw new ControlFailure('unavailable')
    c.header('Cache-Control', 'public, max-age=300')
    return c.json(deps.config.grantKeys.keyset)
  })
}
