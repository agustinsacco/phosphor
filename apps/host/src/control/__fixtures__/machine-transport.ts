import { createHash } from 'node:crypto'
import { formatKeyFingerprint, HOST_HEADERS, CONTROL_ROUTES } from '@phosphor/shared/control-api'
import type { ControlContext } from '../command'

export const hostId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
export const timestamp = '2026-10-10T00:00:00.000Z'
export const serverView = {
  hostId,
  label: 'bee1',
  owner: { login: 'me' },
  enrolledAt: timestamp,
  lastSeenAt: null,
}

/** How the fake control plane answers: normally, 410 on Host routes, unreachable, or 503. */
export type ControlMode = 'ok' | 'gone' | 'offline' | 'unavailable'

export interface ControlCall {
  path: string
  method: string
  body: string
  headers: Headers
  /** The fixture clock when the request was sent. */
  at: number
}

/** One fixture's control plane: its clock, the requests it saw and the answers it gives. */
export interface ControlTransportState {
  /** Fixture time in ms. Each call records it; enrollments expire ten minutes after it. */
  clock: number
  calls: ControlCall[]
  /** Enrollment polls answered so far. */
  polls: number
  /** Applies to every request not sent as the enrolled `hostId`. */
  mode: ControlMode
  /** Applies to requests sent as the enrolled `hostId`. */
  finalMode: ControlMode
  /** The enrollment poll answer. */
  answer: unknown
  /** Merged over the enrollment creation answer. */
  creation: Record<string, unknown>
}

export function controlTransportState(clock: number): ControlTransportState {
  return {
    clock,
    calls: [],
    polls: 0,
    mode: 'ok',
    finalMode: 'ok',
    answer: { status: 'approved', hostId, label: 'bee1', owner: { login: 'me' } },
    creation: {},
  }
}

/** A fetch that records each request in `state`, then answers it by mode and route. */
export function controlTransport(
  state: ControlTransportState,
): NonNullable<ControlContext['fetch']> {
  return async (url, init) => {
    const path = new URL(String(url)).pathname
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? init.body : ''
    state.calls.push({ path, headers, body, method: init?.method ?? '', at: state.clock })
    const chosen = headers.get(HOST_HEADERS.host) === hostId ? state.finalMode : state.mode
    return modeFailure(chosen, path) ?? routeAnswer(state, path, headers)
  }
}

function modeFailure(mode: ControlMode, path: string): Response | undefined {
  if (mode === 'offline') throw new Error('transport contains secret')
  if (mode === 'gone' && path.startsWith(CONTROL_ROUTES.hostSelf))
    return new Response('secret', { status: 410 })
  if (mode === 'unavailable')
    return Response.json({ error: { code: 'unavailable', message: 'secret' } }, { status: 503 })
  return undefined
}

function routeAnswer(state: ControlTransportState, path: string, headers: Headers): Response {
  if (path === CONTROL_ROUTES.enrollments) {
    const raw = Buffer.from(headers.get(HOST_HEADERS.key) ?? '', 'base64url')
    return Response.json({
      enrollmentId: hostId,
      userCode: 'BCDFGHJK',
      keyFingerprint: formatKeyFingerprint(createHash('sha256').update(raw).digest()),
      expiresAt: new Date(state.clock + 600_000).toISOString(),
      pollIntervalSec: 5,
      ...state.creation,
    })
  }
  if (path === CONTROL_ROUTES.enrollmentPoll) {
    state.polls++
    return Response.json(state.answer)
  }
  if (path === CONTROL_ROUTES.hostRevoke) return new Response(null, { status: 204 })
  return Response.json({ ...serverView, hostId: headers.get(HOST_HEADERS.host) })
}
