import { createHash } from 'node:crypto'
import type { Hono } from 'hono'
import {
  CONTROL_LIMITS,
  CONTROL_ROUTES,
  formatKeyFingerprint,
  userCodeFromBytes,
  parseEnrollmentCreateRequest,
  parseEnrollmentCreateResponse,
  parseEnrollmentPollRequest,
  parseEnrollmentPollResponse,
  parseEnrollmentLookupRequest,
  parseEnrollmentLookupResponse,
  parseEnrollmentApproveRequest,
  parseEnrollmentApproveResponse,
} from '@phosphor/shared/control-api'
import type { AppDeps } from '../app'
import type { HostAuthDeps } from '../auth/host'
import { userGuard, type createUserAuth } from '../auth/user'
import { ControlFailure, type Env } from '../http'
import { body, host, outcome, parsed, record } from './shared'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const failureWindow = 15 * 60_000
export function enrollments(
  app: Hono<Env>,
  deps: AppDeps,
  auth: ReturnType<typeof createUserAuth>,
  hostAuth: HostAuthDeps,
) {
  app.post(CONTROL_ROUTES.enrollments, async (c) => {
    if (!deps.limits.consume('enrollment-create:' + c.get('ip'), 10, 3_600_000))
      throw new ControlFailure('too-many-requests')
    const input = parsed(parseEnrollmentCreateRequest(body(c)), 'bad-request')
    const key = await host(c, hostAuth, 'key')
    if (key !== input.publicKey) throw new ControlFailure('bad-request')
    const keyFingerprint = formatKeyFingerprint(
      createHash('sha256').update(Buffer.from(key, 'base64url')).digest(),
    )
    for (let attempt = 0; attempt < 3; attempt++) {
      // Bound even rejection sampling when a faulty random port returns no usable bytes.
      let userCode: string | null = null
      for (let draw = 0; draw < 3 && userCode === null; draw++)
        userCode = userCodeFromBytes(deps.random(32))
      if (userCode === null) throw new ControlFailure('unavailable')
      const value = record(
        await deps.supabase.rpc('control_enrollment_create', {
          p_public_key: key,
          p_key_fingerprint: keyFingerprint,
          p_code_hash: hash(userCode),
          p_hostname: input.hostname,
          p_platform: input.platform,
          p_arch: input.arch,
          p_host_version: input.hostVersion,
        }),
      )
      if (value.outcome === 'code-collision') continue
      outcome(value, 'created')
      return c.json(
        parsed(
          parseEnrollmentCreateResponse({
            enrollmentId: value.enrollmentId,
            userCode,
            keyFingerprint,
            expiresAt: value.expiresAt,
            pollIntervalSec: CONTROL_LIMITS.enrollmentPollSec,
          }),
        ),
      )
    }
    throw new ControlFailure('unavailable')
  })
  app.post(CONTROL_ROUTES.enrollmentPoll, async (c) => {
    // Per address first: the per-enrollment key below comes from an unverified
    // body, and both it and a verified self-made key's nonce cost shared memory.
    // A Host polls every enrollmentPollSec (12 a minute), so 60 fits five at once.
    if (!deps.limits.consume('enrollment-poll-ip:' + c.get('ip'), 60, 60_000))
      throw new ControlFailure('too-many-requests')
    const input = parsed(parseEnrollmentPollRequest(body(c)), 'bad-request')
    if (!deps.limits.consume('enrollment-poll:' + input.enrollmentId, 1, 2000))
      throw new ControlFailure('too-many-requests')
    const key = await host(c, hostAuth, 'key')
    const value = record(
      await deps.supabase.rpc('control_enrollment_poll', {
        p_enrollment_id: input.enrollmentId,
        p_public_key: key,
      }),
    )
    if (value.outcome !== 'pending' && value.outcome !== 'approved' && value.outcome !== 'expired')
      outcome(value, 'pending')
    return c.json(parsed(parseEnrollmentPollResponse({ ...value, status: value.outcome })))
  })
  const guard = userGuard(auth, deps.supabase)
  // Guesses still awaiting the database count against the failure budget too,
  // or concurrent requests could all pass the check before any failure lands.
  // An entry lives only while a request for that user is in flight.
  const inFlight = new Map<string, number>()
  for (const approve of [false, true]) {
    app.post(
      approve ? CONTROL_ROUTES.enrollmentApprove : CONTROL_ROUTES.enrollmentLookup,
      guard,
      async (c) => {
        const input = approve
          ? parsed(parseEnrollmentApproveRequest(body(c)), 'bad-request')
          : parsed(parseEnrollmentLookupRequest(body(c)), 'bad-request')
        const key = 'enrollment-failure:' + c.get('user').userId
        const held = inFlight.get(key) ?? 0
        if (!deps.limits.available(key, 10 - held, failureWindow))
          throw new ControlFailure('too-many-requests')
        inFlight.set(key, held + 1)
        let value: Record<string, unknown>
        try {
          value = record(
            await deps.supabase.rpc(
              approve ? 'control_enrollment_approve' : 'control_enrollment_lookup',
              {
                p_user_id: c.get('user').userId,
                p_code_hash: hash(input.userCode),
                ...('label' in input ? { p_label: input.label } : {}),
              },
            ),
          )
          if (value.outcome === 'not-found' && !deps.limits.consume(key, 10, failureWindow))
            throw new ControlFailure('too-many-requests')
        } finally {
          const left = (inFlight.get(key) ?? 1) - 1
          if (left > 0) inFlight.set(key, left)
          else inFlight.delete(key)
        }
        outcome(value, approve ? 'approved' : 'found')
        return approve
          ? c.json(parsed(parseEnrollmentApproveResponse(value)))
          : c.json(parsed(parseEnrollmentLookupResponse(value)))
      },
    )
  }
}
