import { describe, expect, it } from 'vitest'
import {
  CONTROL_ERROR_STATUS,
  CONTROL_LIMITS,
  CONTROL_ROUTES,
  USER_CODE_ALPHABET,
  formatKeyFingerprint,
  formatUserCode,
  hostSigningString,
  isEndpoint,
  isHostname,
  isNonce,
  isPublicKey,
  isSignature,
  isVersion,
  machineRoute,
  machineStatus,
  normalizeLabel,
  normalizeUserCode,
  parseControlError,
  parseEnrollmentApproveRequest,
  parseEnrollmentCreateRequest,
  parseEnrollmentCreateResponse,
  parseEnrollmentLookupRequest,
  parseEnrollmentPollResponse,
  parseHeartbeatRequest,
  parseHeartbeatResponse,
  parseHostSelfResponse,
  parseMachinesResponse,
  parseMeResponse,
  parseTimestamp,
  userCodeFromBytes,
  withinSkew,
} from './control-api'

const KEY = 'A'.repeat(43)
const ID = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
const machine = {
  id: ID,
  label: 'bee1',
  hostname: 'bee1',
  platform: 'linux',
  arch: 'x64',
  hostVersion: '0.2.0',
  keyFingerprint: '0a1b-2c3d-4e5f-6a7b',
  enrolledAt: '2026-10-12T10:00:00.000Z',
  lastSeenAt: '2026-10-12T10:05:00.000Z',
  state: 'running',
  readiness: { pi: 'ok', claude: 'signed-out', tailscale: 'ok' },
  lanes: { running: 2, waiting: 1 },
  endpoint: 'https://bee1.tail9f6158.ts.net',
}

describe('host signing', () => {
  it('signs a fixed, newline-joined string with the method uppercased', () => {
    expect(
      hostSigningString({
        method: 'post',
        path: CONTROL_ROUTES.hostHeartbeat,
        identity: ID,
        timestamp: '1792000000',
        nonce: 'n'.repeat(22),
        bodySha256: 'e'.repeat(64),
      }),
    ).toBe(
      `phosphor-host-v1\nPOST\n/api/v1/hosts/self/heartbeat\n${ID}\n1792000000\n${'n'.repeat(22)}\n${'e'.repeat(64)}`,
    )
  })

  it('accepts exactly the base64url lengths of raw Ed25519 keys, signatures and nonces', () => {
    expect(isPublicKey(KEY)).toBe(true)
    expect(isPublicKey(`${KEY}=`)).toBe(false)
    expect(isPublicKey('A'.repeat(42))).toBe(false)
    expect(isPublicKey('+'.repeat(43))).toBe(false)
    expect(isSignature('a'.repeat(86))).toBe(true)
    expect(isSignature('a'.repeat(88))).toBe(false)
    expect(isNonce('a'.repeat(22))).toBe(true)
    expect(isNonce('a'.repeat(21))).toBe(false)
  })

  it('reads timestamps strictly and allows sixty seconds of skew either way', () => {
    expect(parseTimestamp('1792000000')).toBe(1_792_000_000)
    for (const bad of ['01792000000', '-1', '1.5', ' 1', '', 1792000000]) {
      expect(parseTimestamp(bad)).toBeNull()
    }
    const now = 1_792_000_000_000
    expect(withinSkew(1_792_000_060, now)).toBe(true)
    expect(withinSkew(1_791_999_940, now)).toBe(true)
    expect(withinSkew(1_792_000_061, now)).toBe(false)
    expect(withinSkew(1_791_999_939, now)).toBe(false)
  })

  it('formats the first eight digest bytes as four hex groups', () => {
    const digest = Uint8Array.from([0x0a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f, 0x6a, 0x7b, 0xff])
    expect(formatKeyFingerprint(digest)).toBe('0a1b-2c3d-4e5f-6a7b')
    expect(() => formatKeyFingerprint(new Uint8Array(7))).toThrow()
  })
})

describe('user codes', () => {
  it('maps bytes below 240 uniformly and skips the rest', () => {
    const bytes = Uint8Array.from([240, 255, 0, 1, 19, 20, 239, 241, 2, 3, 4])
    expect(userCodeFromBytes(bytes)).toBe('BCZBZDFG')
    expect(userCodeFromBytes(new Uint8Array(7))).toBeNull()
    expect(userCodeFromBytes(Uint8Array.from(new Array(30).fill(250)))).toBeNull()
    expect(USER_CODE_ALPHABET).toHaveLength(20)
    expect(new Set(USER_CODE_ALPHABET).size).toBe(20)
    expect(USER_CODE_ALPHABET).not.toMatch(/[AEIOU01]/)
  })

  it('forgives case, spaces and dashes, and nothing else', () => {
    expect(formatUserCode('BCDFGHJK')).toBe('BCDF-GHJK')
    expect(normalizeUserCode('bcdf-ghjk')).toBe('BCDFGHJK')
    expect(normalizeUserCode(' BCDF GHJK ')).toBe('BCDFGHJK')
    for (const bad of ['BCDF-GHJ', 'BCDF-GHJKL', 'ACDF-GHJK', 'BCDF_GHJK', 'BCDF-GHJ0', 42, null]) {
      expect(normalizeUserCode(bad)).toBeNull()
    }
    expect(normalizeUserCode(`${'-'.repeat(25)}BCDFGHJK`)).toBeNull()
  })
})

describe('field rules', () => {
  it('trims labels and refuses empty, long or control-character ones', () => {
    expect(normalizeLabel('  bee1  ')).toBe('bee1')
    expect(normalizeLabel('Pop!_OS desktop · 🐝')).toBe('Pop!_OS desktop · 🐝')
    expect(normalizeLabel('x'.repeat(CONTROL_LIMITS.labelChars))).not.toBeNull()
    for (const bad of ['', '   ', 'x'.repeat(81), 'a\nb', 'a\u0000', 'a\u009b', 7]) {
      expect(normalizeLabel(bad)).toBeNull()
    }
  })

  it('takes hostnames, versions and bare HTTPS origins only', () => {
    expect(isHostname('Agustins-MacBook-Pro.local')).toBe(true)
    expect(isHostname('-bad')).toBe(false)
    expect(isHostname('a b')).toBe(false)
    expect(isVersion('0.2.0')).toBe(true)
    expect(isVersion('1.2.3-rc.1')).toBe(true)
    expect(isVersion('1.2')).toBe(false)
    expect(isEndpoint('https://bee1.tail9f6158.ts.net')).toBe(true)
    expect(isEndpoint('https://bee1.tail9f6158.ts.net:8443')).toBe(true)
    for (const bad of [
      'http://bee1.ts.net',
      'https://bee1.ts.net/',
      'https://bee1.ts.net/x',
      'https://user@bee1.ts.net',
      'https://BEE1.ts.net',
      'https://bee1.ts.net:0',
      'https://bee1.ts.net?x=1',
    ]) {
      expect(isEndpoint(bad)).toBe(false)
    }
  })
})

describe('requests', () => {
  it('keeps known enrollment fields and drops unknown ones', () => {
    const parsed = parseEnrollmentCreateRequest({
      publicKey: KEY,
      hostname: 'bee1',
      platform: 'linux',
      arch: 'x64',
      hostVersion: '0.2.0',
      extra: 'ignored',
    })
    expect(parsed).toEqual({
      ok: true,
      value: {
        publicKey: KEY,
        hostname: 'bee1',
        platform: 'linux',
        arch: 'x64',
        hostVersion: '0.2.0',
      },
    })
    expect(parseEnrollmentCreateRequest({ publicKey: KEY })).toMatchObject({ ok: false })
    expect(parseEnrollmentCreateRequest([])).toMatchObject({ ok: false })
  })

  it('normalizes codes and labels a user typed', () => {
    expect(parseEnrollmentLookupRequest({ userCode: 'bcdf-ghjk' })).toEqual({
      ok: true,
      value: { userCode: 'BCDFGHJK' },
    })
    expect(parseEnrollmentApproveRequest({ userCode: 'bcdfghjk', label: ' bee1 ' })).toEqual({
      ok: true,
      value: { userCode: 'BCDFGHJK', label: 'bee1' },
    })
    expect(parseEnrollmentApproveRequest({ userCode: 'bcdfghjk', label: '' })).toEqual({
      ok: false,
      reason: 'label',
    })
  })

  it('bounds every heartbeat field', () => {
    const beat = {
      seq: 7,
      state: 'running',
      hostVersion: '0.2.0',
      uptimeSec: 120,
      readiness: { pi: 'ok', claude: 'ok', tailscale: 'no-https' },
      lanes: { running: 0, waiting: 0 },
      endpoint: null,
    }
    expect(parseHeartbeatRequest(beat)).toEqual({ ok: true, value: beat })
    for (const [field, bad] of [
      ['seq', 0],
      ['seq', 1.5],
      ['state', 'paused'],
      ['uptimeSec', -1],
      ['readiness', { pi: 'ok', claude: 'ok' }],
      ['lanes', { running: 10_001, waiting: 0 }],
      ['endpoint', 'https://bee1.ts.net/path'],
    ] as const) {
      expect(parseHeartbeatRequest({ ...beat, [field]: bad })).toEqual({ ok: false, reason: field })
    }
  })
})

describe('responses', () => {
  it('parses a machine list and rejects a malformed machine', () => {
    const list = { machines: [machine], serverTime: '2026-10-12T10:05:10.000Z' }
    expect(parseMachinesResponse(list)).toEqual({ ok: true, value: list })
    expect(
      parseMachinesResponse({ ...list, machines: [{ ...machine, endpoint: 'http://x' }] }),
    ).toEqual({ ok: false, reason: 'machines: endpoint' })
    const blank = {
      ...machine,
      hostVersion: null,
      lastSeenAt: null,
      state: null,
      readiness: null,
      lanes: null,
      endpoint: null,
    }
    expect(parseMachinesResponse({ ...list, machines: [blank] })).toMatchObject({ ok: true })
  })

  it('parses each enrollment poll outcome', () => {
    expect(parseEnrollmentPollResponse({ status: 'pending' })).toEqual({
      ok: true,
      value: { status: 'pending' },
    })
    expect(
      parseEnrollmentPollResponse({
        status: 'approved',
        hostId: ID,
        label: 'bee1',
        owner: { login: 'octo' },
      }),
    ).toMatchObject({ ok: true })
    expect(
      parseEnrollmentPollResponse({
        status: 'approved',
        hostId: ID,
        label: 'bee1',
        owner: { login: 'a b' },
      }),
    ).toEqual({ ok: false, reason: 'owner' })
    expect(parseEnrollmentPollResponse({ status: 'denied' })).toEqual({
      ok: false,
      reason: 'status',
    })
  })

  it('requires the canonical code from the server', () => {
    const response = {
      enrollmentId: ID,
      userCode: 'BCDFGHJK',
      keyFingerprint: '0a1b-2c3d-4e5f-6a7b',
      expiresAt: '2026-10-12T10:10:00.000Z',
      pollIntervalSec: 5,
    }
    expect(parseEnrollmentCreateResponse(response)).toEqual({ ok: true, value: response })
    expect(parseEnrollmentCreateResponse({ ...response, userCode: 'BCDF-GHJK' })).toEqual({
      ok: false,
      reason: 'userCode',
    })
  })

  it('parses me, host self and heartbeat replies', () => {
    expect(
      parseMeResponse({ account: { login: 'octo' }, enabled: true, maxHosts: 20 }),
    ).toMatchObject({ ok: true })
    expect(
      parseHostSelfResponse({
        hostId: ID,
        label: 'bee1',
        owner: { login: null },
        enrolledAt: machine.enrolledAt,
        lastSeenAt: null,
      }),
    ).toMatchObject({ ok: true })
    expect(parseHeartbeatResponse({ accepted: true, nextInSec: 30 })).toMatchObject({ ok: true })
    expect(parseHeartbeatResponse({ accepted: true, nextInSec: 1 })).toMatchObject({ ok: false })
  })

  it('reads error bodies and caps their messages', () => {
    expect(
      parseControlError({ error: { code: 'gone', message: 'x'.repeat(500) } })?.error.message,
    ).toHaveLength(300)
    expect(parseControlError({ error: { code: 'teapot', message: 'no' } })).toBeNull()
    expect(CONTROL_ERROR_STATUS.gone).toBe(410)
  })
})

describe('machine status', () => {
  const seen = Date.parse(machine.lastSeenAt)

  it('is up through ninety seconds after a running beat, then down', () => {
    expect(machineStatus(machine as never, seen + 90_000)).toBe('up')
    expect(machineStatus(machine as never, seen + 90_001)).toBe('down')
  })

  it('corrects for the client clock and treats a stopping beat as down at once', () => {
    expect(machineStatus(machine as never, seen + 100_000, -20_000)).toBe('up')
    expect(machineStatus({ ...machine, state: 'stopping' } as never, seen)).toBe('down')
    expect(machineStatus({ lastSeenAt: null, state: null }, seen)).toBe('never-seen')
  })

  it('builds the per-machine route', () => {
    expect(machineRoute(ID)).toBe(`/api/v1/machines/${ID}`)
  })
})
