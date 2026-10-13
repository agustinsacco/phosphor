import { describe, expect, it } from 'vitest'
import vector from './__fixtures__/control-signing-vector.json'
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
  isIsoTime,
  isNonce,
  isPublicKey,
  isSignature,
  isUuid,
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
  parseEnrollmentLookupResponse,
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
    expect(isSignature('A'.repeat(86))).toBe(true)
    expect(isSignature('A'.repeat(88))).toBe(false)
    expect(isNonce('A'.repeat(22))).toBe(true)
    expect(isNonce('A'.repeat(21))).toBe(false)
  })

  it('takes only the canonical spelling, so one key cannot pass as several', () => {
    const stem = vector.publicKey.slice(0, -1)
    expect(vector.publicKey.endsWith('Q')).toBe(true)
    expect(isPublicKey(vector.publicKey)).toBe(true)
    for (const alias of ['R', 'S', 'T']) expect(isPublicKey(`${stem}${alias}`)).toBe(false)
    for (const bad of ['+', '/', '=', '.', ' ']) {
      expect(isPublicKey(`${bad}${vector.publicKey.slice(1)}`)).toBe(false)
    }
    for (const last of 'AEIMQUYcgkosw048') expect(isPublicKey(`${stem}${last}`)).toBe(true)
    for (const last of 'AQgw') {
      expect(isSignature(`${'A'.repeat(85)}${last}`)).toBe(true)
      expect(isNonce(`${'A'.repeat(21)}${last}`)).toBe(true)
    }
    for (const last of 'BRhx-_') {
      expect(isSignature(`${'A'.repeat(85)}${last}`)).toBe(false)
      expect(isNonce(`${'A'.repeat(21)}${last}`)).toBe(false)
    }
    expect(isSignature(vector.signature)).toBe(true)
    expect(isNonce(vector.input.nonce)).toBe(true)
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

  it('refuses labels that would display differently from what they are', () => {
    for (const mark of ['\u061c', '\u200e', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069']) {
      expect(normalizeLabel(`bee${mark}12`)).toBeNull()
    }
    expect(normalizeLabel('bee1\u2028admin')).toBeNull()
    expect(normalizeLabel('bee1\u2029admin')).toBeNull()
    expect(normalizeLabel('ビー1 · café')).toBe('ビー1 · café')
    expect(parseEnrollmentApproveRequest({ userCode: 'BCDFGHJK', label: 'bee\u202e12' })).toEqual({
      ok: false,
      reason: 'label',
    })
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
    expect(isEndpoint('https://bee1.tail9f6158.ts.net:65535')).toBe(true)
    expect(isEndpoint('https://bee1.tail9f6158.ts.net:65536')).toBe(false)
    expect(isEndpoint('https://bee1.tail9f6158.ts.net:99999')).toBe(false)
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

describe('strict identifiers and times', () => {
  it('takes lowercase uuids only, as Postgres writes them', () => {
    expect(isUuid(ID)).toBe(true)
    expect(isUuid(ID.toUpperCase())).toBe(false)
    expect(isUuid(`${ID.slice(0, 8).toUpperCase()}${ID.slice(8)}`)).toBe(false)
    expect(isUuid(`${ID.slice(0, 32)}${ID.slice(32).toUpperCase()}`)).toBe(false)
    expect(isUuid(`${ID}0`)).toBe(false)
  })

  it('takes UTC times exactly as toISOString writes them', () => {
    expect(isIsoTime('2026-10-12T10:00:00.000Z')).toBe(true)
    expect(isIsoTime(new Date(0).toISOString())).toBe(true)
    for (const bad of [
      '1',
      'Tue Oct 12 2026',
      '2026-10-12',
      '2026-10-12T10:00:00',
      '2026-01-12T10:05:10',
      '2026-10-12T10:00:00Z',
      '2026-10-12T10:00:00.000+00:00',
      '2026-10-12T10:00:00.000000Z',
      '2026-10-12T10:00:00.000Z ',
      '2026-02-30T10:00:00.000Z',
      '2026-13-45T99:99:99.000Z',
      '+010000-01-01T00:00:00.000Z',
      '-000001-01-01T00:00:00.000Z',
      7,
    ]) {
      expect(isIsoTime(bad)).toBe(false)
    }
    expect(parseMachinesResponse({ machines: [], serverTime: '2026-01-12T10:05:10' })).toEqual({
      ok: false,
      reason: 'serverTime',
    })
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
    const create = {
      publicKey: KEY,
      hostname: 'bee1',
      platform: 'linux',
      arch: 'x64',
      hostVersion: '0.2.0',
    }
    expect(parseEnrollmentCreateRequest({ ...create, platform: 'freebsd' })).toEqual({
      ok: false,
      reason: 'platform',
    })
    expect(parseEnrollmentCreateRequest({ ...create, arch: 'ia32' })).toEqual({
      ok: false,
      reason: 'arch',
    })
    expect(parseEnrollmentCreateRequest({ ...create, publicKey: `${KEY.slice(0, -1)}B` })).toEqual({
      ok: false,
      reason: 'publicKey',
    })
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
  it('rejects labels that would display differently in every response that carries one', () => {
    for (const label of ['bee\u202e12', 'bee1\u2028admin']) {
      expect(
        parseMachinesResponse({
          machines: [{ ...machine, label }],
          serverTime: machine.enrolledAt,
        }),
      ).toEqual({ ok: false, reason: 'machines: label' })
      expect(
        parseHostSelfResponse({
          hostId: ID,
          label,
          owner: { login: 'octo' },
          enrolledAt: machine.enrolledAt,
          lastSeenAt: null,
        }),
      ).toEqual({ ok: false, reason: 'label' })
      expect(
        parseEnrollmentPollResponse({
          status: 'approved',
          hostId: ID,
          label,
          owner: { login: 'octo' },
        }),
      ).toEqual({ ok: false, reason: 'label' })
    }
  })

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
    expect(
      parseEnrollmentPollResponse({
        status: 'approved',
        hostId: ID,
        label: ' bee1 ',
        owner: { login: 'octo' },
      }),
    ).toEqual({ ok: false, reason: 'label' })
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
    for (const userCode of [null, undefined, 42]) {
      expect(parseEnrollmentCreateResponse({ ...response, userCode })).toEqual({
        ok: false,
        reason: 'userCode',
      })
    }
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
    expect(parseMeResponse({ account: { login: 'octo' }, enabled: 'yes', maxHosts: 20 })).toEqual({
      ok: false,
      reason: 'enabled',
    })
  })

  it('checks every field a person compares before approving', () => {
    const lookup = {
      hostname: 'bee1',
      platform: 'linux',
      arch: 'x64',
      hostVersion: '0.2.0',
      keyFingerprint: '0a1b-2c3d-4e5f-6a7b',
      expiresAt: '2026-10-12T10:10:00.000Z',
    }
    expect(parseEnrollmentLookupResponse(lookup)).toEqual({ ok: true, value: lookup })
    expect(parseEnrollmentLookupResponse({ ...lookup, keyFingerprint: '0a1b2c3d' })).toEqual({
      ok: false,
      reason: 'keyFingerprint',
    })
    expect(parseEnrollmentLookupResponse({ ...lookup, expiresAt: '1' })).toEqual({
      ok: false,
      reason: 'expiresAt',
    })
  })

  it('bounds the machine list', () => {
    const many = new Array(CONTROL_LIMITS.maxHostsPerAccount * 5 + 1).fill(machine)
    expect(parseMachinesResponse({ machines: many, serverTime: machine.enrolledAt })).toEqual({
      ok: false,
      reason: 'machines',
    })
    expect(
      parseMachinesResponse({ machines: many.slice(1), serverTime: machine.enrolledAt }),
    ).toMatchObject({ ok: true })
  })

  it('reads error bodies and caps their messages', () => {
    expect(
      parseControlError({ error: { code: 'gone', message: 'x'.repeat(500) } })?.error.message,
    ).toHaveLength(300)
    expect(parseControlError({ error: { code: 'teapot', message: 'no' } })).toBeNull()
    for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(parseControlError({ error: { code, message: 'no' } })).toBeNull()
    }
    expect(parseControlError({ error: { code: 'gone', message: 7 } })).toBeNull()
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

describe('control trace header validators', () => {
  it('accepts only bounded client versions and lowercase 16-byte hex text', async () => {
    const { isControlClient, isControlTrace, CONTROL_TRACE_HEADERS } = await import('./control-api')
    expect(CONTROL_TRACE_HEADERS).toEqual({
      client: 'x-phosphor-client',
      trace: 'x-phosphor-trace',
    })
    for (const kind of ['desktop', 'host']) {
      expect(isControlClient(`${kind}/${'a'.repeat(40)}`)).toBe(true)
      expect(isControlClient(`${kind}/${'a'.repeat(41)}`)).toBe(false)
      expect(isControlClient(`${kind}/1.2.3-dev+build`)).toBe(true)
    }
    for (const value of ['', null, 'host/', 'other/1', 'host/1 secret', 'host/1\n', 'host/1/2'])
      expect(isControlClient(value)).toBe(false)
    expect(isControlTrace('0123456789abcdef')).toBe(true)
    for (const value of [
      '',
      null,
      '0123456789abcde',
      '0123456789abcdef0',
      '0123456789ABCDEf',
      '0123456789abcdeg',
      '0123456789abcdef\n',
    ])
      expect(isControlTrace(value)).toBe(false)
  })
})
