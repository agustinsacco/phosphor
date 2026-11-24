import { describe, expect, it } from 'vitest'
import {
  CONTROL_LIMITS,
  CONTROL_MACHINE_ROUTES,
  CONTROL_ROUTES,
  machineReachRoute,
  parseMachineDirectoryResponse,
  parseMachineGrantIssueRequest,
  parseMachineReachRequest,
  parseMachineReachResponse,
} from '../control-api'

const ID = '00000000-0000-4000-8000-000000000001'
const SELF = '00000000-0000-4000-8000-000000000002'
const TIME = '2026-01-01T00:00:00.000Z'
const ENTRY = {
  id: ID,
  label: 'bee1',
  hostVersion: '1.2.3',
  lastSeenAt: TIME,
  state: 'running',
  readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
  machineGrants: true,
  machineReach: true,
  reachable: false,
}
const DIRECTORY = {
  self: { id: SELF, label: 'stark', machineReach: true },
  machines: [ENTRY],
  serverTime: TIME,
}

describe('machine reach routes', () => {
  it('stay apart from CONTROL_ROUTES', () => {
    for (const route of Object.values(CONTROL_MACHINE_ROUTES))
      expect(Object.values(CONTROL_ROUTES)).not.toContain(route)
    expect(machineReachRoute(ID)).toBe(`/api/v1/machines/${ID}/reach`)
  })
})

describe('machine reach bodies', () => {
  it('reads the directory with self label and reachable, dropping unknown keys', () => {
    expect(parseMachineDirectoryResponse(DIRECTORY)).toStrictEqual({ ok: true, value: DIRECTORY })
    const extra = { ...DIRECTORY, machines: [{ ...ENTRY, endpoint: 'https://x.ts.net' }] }
    expect(parseMachineDirectoryResponse(extra)).toStrictEqual({ ok: true, value: DIRECTORY })
  })

  it('refuses a directory without self label, reachable or within the host cap', () => {
    const { reachable: _reachable, ...noReach } = ENTRY
    for (const bad of [
      { ...DIRECTORY, self: { id: SELF, machineReach: true } },
      { ...DIRECTORY, machines: [noReach] },
      {
        ...DIRECTORY,
        machines: Array.from({ length: CONTROL_LIMITS.maxHostsPerAccount + 1 }, () => ENTRY),
      },
      { ...DIRECTORY, machines: [{ ...ENTRY, state: 'gone' }] },
    ])
      expect(parseMachineDirectoryResponse(bad).ok).toBe(false)
  })

  it('reads issue and reach requests and responses', () => {
    expect(parseMachineGrantIssueRequest({ targetHostId: ID })).toStrictEqual({
      ok: true,
      value: { targetHostId: ID },
    })
    expect(parseMachineGrantIssueRequest({ targetHostId: 'bee1' }).ok).toBe(false)
    expect(parseMachineReachRequest({ enabled: false })).toStrictEqual({
      ok: true,
      value: { enabled: false },
    })
    expect(parseMachineReachRequest({ enabled: 'off' }).ok).toBe(false)
    expect(parseMachineReachResponse({ machineReach: true })).toStrictEqual({
      ok: true,
      value: { machineReach: true },
    })
  })
})
