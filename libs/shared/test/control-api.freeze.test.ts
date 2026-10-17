// Freezes the control plane's route strings. Baselines are literal values,
// never snapshots, so no update flag can rewrite them.
import { describe, expect, it } from 'vitest'
import {
  CONTROL_API_PREFIX,
  CONTROL_API_VERSION,
  CONTROL_ROUTES,
  machineRoute,
} from '@phosphor/shared/control-api'

describe('control API routes', () => {
  it('keeps every route string exactly', () => {
    expect(CONTROL_API_VERSION).toBe(1)
    expect(CONTROL_API_PREFIX).toBe('/api/v1')
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
    })
  })

  it('forms the machine path from the machines route and the machine id', () => {
    expect(machineRoute('00000000-0000-4000-8000-00000000000d')).toBe(
      '/api/v1/machines/00000000-0000-4000-8000-00000000000d',
    )
  })
})
