import { describe, expect, it } from 'vitest'
import * as facade from '../control-api'
import {
  CONTROL_API_PREFIX,
  CONTROL_API_VERSION,
  CONTROL_ERROR_STATUS,
  CONTROL_LIMITS,
  CONTROL_ROUTES,
  CONTROL_TRACE_HEADERS,
  DEFAULT_CONTROL_URL,
  isControlClient,
  isControlTrace,
  machineRoute,
} from './constants'

describe('control wire constants', () => {
  it('hangs every route from the version prefix', () => {
    expect(CONTROL_API_PREFIX).toBe(`/api/v${CONTROL_API_VERSION}`)
    expect(DEFAULT_CONTROL_URL).toBe('https://phosphor.saccolabs.com')
    expect(CONTROL_ROUTES).toStrictEqual({
      health: '/api/v1/health',
      me: '/api/v1/me',
      enrollments: '/api/v1/enrollments',
      enrollmentPoll: '/api/v1/enrollments/poll',
      enrollmentLookup: '/api/v1/enrollments/lookup',
      enrollmentApprove: '/api/v1/enrollments/approve',
      machines: '/api/v1/machines',
      clients: '/api/v1/clients',
      grants: '/api/v1/grants',
      grantKeys: '/api/v1/grant-keys',
      hostSelf: '/api/v1/hosts/self',
      hostHeartbeat: '/api/v1/hosts/self/heartbeat',
      hostRevoke: '/api/v1/hosts/self/revoke',
      usagePing: '/api/v1/usage/ping',
      adminStats: '/api/v1/admin/stats',
    })
    expect(machineRoute('m1')).toBe('/api/v1/machines/m1')
  })

  it('keeps limits that agree with each other', () => {
    expect(CONTROL_LIMITS).toStrictEqual({
      bodyBytes: 16_384,
      labelChars: 80,
      hostnameChars: 253,
      enrollmentTtlSec: 600,
      enrollmentPollSec: 5,
      heartbeatSec: 30,
      downAfterSec: 90,
      heartbeatMinSec: 10,
      signatureSkewSec: 60,
      maxHostsPerAccount: 20,
      maxLanes: 10_000,
    })
    expect(CONTROL_LIMITS.downAfterSec).toBe(3 * CONTROL_LIMITS.heartbeatSec)
    expect(CONTROL_LIMITS.heartbeatMinSec).toBeLessThan(CONTROL_LIMITS.heartbeatSec)
    expect(CONTROL_LIMITS.enrollmentPollSec).toBeLessThan(CONTROL_LIMITS.enrollmentTtlSec)
  })

  it('maps each error code to one HTTP status', () => {
    expect(CONTROL_ERROR_STATUS).toStrictEqual({
      'bad-request': 400,
      unauthenticated: 401,
      forbidden: 403,
      'not-found': 404,
      conflict: 409,
      gone: 410,
      'payload-too-large': 413,
      'unsupported-media-type': 415,
      'too-many-requests': 429,
      internal: 500,
      unavailable: 503,
    })
    const statuses = Object.values(CONTROL_ERROR_STATUS)
    expect(new Set(statuses).size).toBe(statuses.length)
  })

  it('validates trace metadata without letting it authorize anything', () => {
    expect(CONTROL_TRACE_HEADERS).toStrictEqual({
      client: 'x-phosphor-client',
      trace: 'x-phosphor-trace',
    })
    expect(isControlClient('desktop/1.2.3')).toBe(true)
    expect(isControlClient(`host/${'9'.repeat(40)}`)).toBe(true)
    for (const bad of ['pwa/1', 'host/', `host/${'9'.repeat(41)}`, 'host/1 2', 7])
      expect(isControlClient(bad)).toBe(false)
    expect(isControlTrace('0123456789abcdef')).toBe(true)
    for (const bad of ['0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0', null])
      expect(isControlTrace(bad)).toBe(false)
  })

  it('is what the control-api entry exports', () => {
    expect(facade.CONTROL_ROUTES).toBe(CONTROL_ROUTES)
    expect(facade.CONTROL_LIMITS).toBe(CONTROL_LIMITS)
    expect(facade.CONTROL_ERROR_STATUS).toBe(CONTROL_ERROR_STATUS)
    expect(facade.CONTROL_TRACE_HEADERS).toBe(CONTROL_TRACE_HEADERS)
    expect(facade.machineRoute).toBe(machineRoute)
    expect(facade.isControlClient).toBe(isControlClient)
    expect(facade.isControlTrace).toBe(isControlTrace)
  })
})
