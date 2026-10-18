// Freezes the control plane's route strings. Baselines are literal values,
// never snapshots, so no update flag can rewrite them.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

describe('control API route formation', () => {
  it('hangs every route from the versioned prefix, once each, without query or trailing slash', () => {
    const routes = Object.values(CONTROL_ROUTES)
    expect(new Set(routes).size).toBe(routes.length)
    for (const route of routes) expect(route, route).toMatch(/^\/api\/v1(?:\/[a-z-]+)+$/)
  })

  it('forms each machine path under the machines route, apart from every static route', () => {
    const ids = ['00000000-0000-4000-8000-00000000000d', 'f47ac10b-58cc-4372-a567-0e02b2c3d479']
    expect(ids.map(machineRoute)).toStrictEqual([
      '/api/v1/machines/00000000-0000-4000-8000-00000000000d',
      '/api/v1/machines/f47ac10b-58cc-4372-a567-0e02b2c3d479',
    ])
    for (const id of ids) {
      expect(machineRoute(id)).toBe(`${CONTROL_ROUTES.machines}/${id}`)
      expect(Object.values(CONTROL_ROUTES)).not.toContain(machineRoute(id))
    }
  })

  it('holds literal baselines that a snapshot update cannot rewrite', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'control-api.freeze.test.ts'), 'utf8')
    expect(source.match(/\.(?:toMatch|toThrowErrorMatching)\w*Snapshot\(/g)).toBeNull()
  })
})
