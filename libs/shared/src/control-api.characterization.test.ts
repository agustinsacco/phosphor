// Characterizes the public control-api entry before it is split into leaf
// modules behind the same path. Literal baselines only, never snapshots: every
// runtime export, every wire type, the signed bytes, the canonical encodings,
// the per-field rules and the projection that drops unknown fields.
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { describe, expect, expectTypeOf, it } from 'vitest'
import vector from './__fixtures__/control-signing-vector.json'
import * as api from './control-api'
import type {
  AccountHandle,
  Arch,
  ClientRegisterRequest,
  ClientRegisterResponse,
  ControlErrorBody,
  ControlErrorCode,
  EnrollmentApproveRequest,
  EnrollmentApproveResponse,
  EnrollmentCreateRequest,
  EnrollmentCreateResponse,
  EnrollmentLookupRequest,
  EnrollmentLookupResponse,
  EnrollmentPollRequest,
  EnrollmentPollResponse,
  GrantIssueRequest,
  GrantIssueResponse,
  HealthResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  HostRevocations,
  HostSelfResponse,
  HostSigningInput,
  LaneCounts,
  MachineRenameRequest,
  MachineState,
  MachineStatus,
  MachineView,
  MachinesResponse,
  MeResponse,
  Parsed,
  Platform,
  Readiness,
} from './control-api'

// Every runtime export, grouped by kind.
const RUNTIME_EXPORTS = {
  object:
    'ARCHES CONTROL_ERROR_STATUS CONTROL_LIMITS CONTROL_ROUTES CONTROL_TRACE_HEADERS HOST_HEADERS PLATFORMS',
  string: 'CONTROL_API_PREFIX DEFAULT_CONTROL_URL HOST_SIGNATURE_SCHEME USER_CODE_ALPHABET',
  number: 'CONTROL_API_VERSION USER_CODE_LENGTH',
  function: `formatKeyFingerprint formatUserCode hostSigningString isControlClient isControlErrorCode
    isControlTrace isEndpoint isHostname isIsoTime isKeyFingerprint isNonce isPublicKey isSha256Hex
    isSignature isUuid isVersion machineRoute machineStatus normalizeLabel normalizeUserCode
    parseClientRegisterRequest parseClientRegisterResponse parseControlError
    parseEnrollmentApproveRequest parseEnrollmentApproveResponse parseEnrollmentCreateRequest
    parseEnrollmentCreateResponse parseEnrollmentLookupRequest parseEnrollmentLookupResponse
    parseEnrollmentPollRequest parseEnrollmentPollResponse parseGrantIssueRequest
    parseGrantIssueResponse parseHealthResponse parseHeartbeatRequest parseHeartbeatResponse
    parseHostRevocations parseHostSelfResponse parseMachineRenameRequest parseMachineView
    parseMachinesResponse parseMeResponse parseTimestamp userCodeFromBytes withinSkew`,
}

const ID = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
const KEY = 'A'.repeat(43)
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const lastChars = (check: (value: unknown) => boolean, length: number) =>
  [...ALPHABET].filter((last) => check(`${'A'.repeat(length - 1)}${last}`)).join('')

describe('public inventory', () => {
  it('exports exactly these runtime names, each of the same kind', () => {
    const kinds = Object.entries(RUNTIME_EXPORTS).flatMap(([kind, names]) =>
      names.split(/\s+/).map((name) => [name, kind]),
    )
    expect(kinds).toHaveLength(58)
    expect(
      Object.fromEntries(
        Object.keys(api).map((name) => [name, typeof api[name as keyof typeof api]]),
      ),
    ).toStrictEqual(Object.fromEntries(kinds))
  })

  it('keeps every constant table, value for value and in key order', () => {
    expect([api.CONTROL_API_VERSION, api.CONTROL_API_PREFIX, api.DEFAULT_CONTROL_URL]).toEqual([
      1,
      '/api/v1',
      'https://phosphor.saccolabs.com',
    ])
    expect(Object.entries(api.CONTROL_TRACE_HEADERS)).toEqual([
      ['client', 'x-phosphor-client'],
      ['trace', 'x-phosphor-trace'],
    ])
    expect(Object.entries(api.CONTROL_LIMITS)).toEqual([
      ['bodyBytes', 16_384],
      ['labelChars', 80],
      ['hostnameChars', 253],
      ['enrollmentTtlSec', 600],
      ['enrollmentPollSec', 5],
      ['heartbeatSec', 30],
      ['downAfterSec', 90],
      ['heartbeatMinSec', 10],
      ['signatureSkewSec', 60],
      ['maxHostsPerAccount', 20],
      ['maxLanes', 10_000],
    ])
    expect(Object.keys(api.CONTROL_ROUTES)).toEqual([
      'health',
      'me',
      'enrollments',
      'enrollmentPoll',
      'enrollmentLookup',
      'enrollmentApprove',
      'machines',
      'clients',
      'grants',
      'grantKeys',
      'hostSelf',
      'hostHeartbeat',
      'hostRevoke',
    ])
    expect(api.HOST_SIGNATURE_SCHEME).toBe('phosphor-host-v1')
    expect(Object.entries(api.HOST_HEADERS)).toEqual([
      ['host', 'x-phosphor-host'],
      ['key', 'x-phosphor-key'],
      ['timestamp', 'x-phosphor-timestamp'],
      ['nonce', 'x-phosphor-nonce'],
      ['signature', 'x-phosphor-signature'],
    ])
    expect(Object.entries(api.CONTROL_ERROR_STATUS)).toEqual([
      ['bad-request', 400],
      ['unauthenticated', 401],
      ['forbidden', 403],
      ['not-found', 404],
      ['conflict', 409],
      ['gone', 410],
      ['payload-too-large', 413],
      ['unsupported-media-type', 415],
      ['too-many-requests', 429],
      ['internal', 500],
      ['unavailable', 503],
    ])
    expect([api.PLATFORMS, api.ARCHES]).toEqual([
      ['linux', 'darwin', 'win32'],
      ['x64', 'arm64'],
    ])
    expect([api.USER_CODE_ALPHABET, api.USER_CODE_LENGTH]).toEqual(['BCDFGHJKLMNPQRSTVWXZ', 8])
  })

  it('keeps the shared unions and generic result shape', () => {
    expectTypeOf<Platform>().toEqualTypeOf<'linux' | 'darwin' | 'win32'>()
    expectTypeOf<Arch>().toEqualTypeOf<'x64' | 'arm64'>()
    expectTypeOf<MachineState>().toEqualTypeOf<'running' | 'stopping'>()
    expectTypeOf<MachineStatus>().toEqualTypeOf<'up' | 'down' | 'never-seen'>()
    expectTypeOf<ControlErrorCode>().toEqualTypeOf<
      | 'bad-request'
      | 'unauthenticated'
      | 'forbidden'
      | 'not-found'
      | 'conflict'
      | 'gone'
      | 'payload-too-large'
      | 'unsupported-media-type'
      | 'too-many-requests'
      | 'internal'
      | 'unavailable'
    >()
    expectTypeOf<ControlErrorBody>().toEqualTypeOf<{
      readonly error: { readonly code: ControlErrorCode; readonly message: string }
    }>()
    expectTypeOf<Parsed<number>>().toEqualTypeOf<
      | { readonly ok: true; readonly value: number }
      | { readonly ok: false; readonly reason: string }
    >()
    expectTypeOf<AccountHandle>().toEqualTypeOf<{ readonly login: string | null }>()
    expectTypeOf<Readiness>().toEqualTypeOf<{
      readonly pi: 'ok' | 'missing' | 'outdated' | 'unknown'
      readonly claude: 'ok' | 'missing' | 'signed-out' | 'unknown'
      readonly tailscale: 'ok' | 'missing' | 'stopped' | 'no-https' | 'unknown'
    }>()
    expectTypeOf<LaneCounts>().toEqualTypeOf<{
      readonly running: number
      readonly waiting: number
    }>()
    expectTypeOf<HostSigningInput>().toEqualTypeOf<{
      readonly method: string
      readonly path: string
      readonly identity: string
      readonly timestamp: string
      readonly nonce: string
      readonly bodySha256: string
    }>()
  })

  it('keeps every enrollment wire type', () => {
    expectTypeOf<EnrollmentCreateRequest>().toEqualTypeOf<{
      readonly publicKey: string
      readonly hostname: string
      readonly platform: Platform
      readonly arch: Arch
      readonly hostVersion: string
    }>()
    expectTypeOf<EnrollmentCreateResponse>().toEqualTypeOf<{
      readonly enrollmentId: string
      readonly userCode: string
      readonly keyFingerprint: string
      readonly expiresAt: string
      readonly pollIntervalSec: number
    }>()
    expectTypeOf<EnrollmentPollRequest>().toEqualTypeOf<{ readonly enrollmentId: string }>()
    expectTypeOf<EnrollmentPollResponse>().toEqualTypeOf<
      | { readonly status: 'pending' }
      | {
          readonly status: 'approved'
          readonly hostId: string
          readonly label: string
          readonly owner: AccountHandle
        }
      | { readonly status: 'expired' }
    >()
    expectTypeOf<EnrollmentLookupRequest>().toEqualTypeOf<{ readonly userCode: string }>()
    expectTypeOf<EnrollmentLookupResponse>().toEqualTypeOf<{
      readonly hostname: string
      readonly platform: Platform
      readonly arch: Arch
      readonly hostVersion: string
      readonly keyFingerprint: string
      readonly expiresAt: string
    }>()
    expectTypeOf<EnrollmentApproveRequest>().toEqualTypeOf<{
      readonly userCode: string
      readonly label: string
    }>()
    expectTypeOf<EnrollmentApproveResponse>().toEqualTypeOf<{ readonly machine: MachineView }>()
  })

  it('keeps every machine, heartbeat and health wire type', () => {
    expectTypeOf<MachineView>().toEqualTypeOf<{
      readonly id: string
      readonly label: string
      readonly hostname: string
      readonly platform: Platform
      readonly arch: Arch
      readonly hostVersion: string | null
      readonly keyFingerprint: string
      readonly enrolledAt: string
      readonly lastSeenAt: string | null
      readonly state: MachineState | null
      readonly readiness: Readiness | null
      readonly lanes: LaneCounts | null
      readonly endpoint: string | null
    }>()
    expectTypeOf<MachinesResponse>().toEqualTypeOf<{
      readonly machines: readonly MachineView[]
      readonly serverTime: string
    }>()
    expectTypeOf<MachineRenameRequest>().toEqualTypeOf<{ readonly label: string }>()
    expectTypeOf<MeResponse>().toEqualTypeOf<{
      readonly account: AccountHandle
      readonly enabled: boolean
      readonly maxHosts: number
    }>()
    expectTypeOf<HostSelfResponse>().toEqualTypeOf<{
      readonly hostId: string
      readonly label: string
      readonly owner: AccountHandle
      readonly enrolledAt: string
      readonly lastSeenAt: string | null
    }>()
    expectTypeOf<HeartbeatRequest>().toEqualTypeOf<{
      readonly seq: number
      readonly state: MachineState
      readonly hostVersion: string
      readonly uptimeSec: number
      readonly readiness: Readiness
      readonly lanes: LaneCounts
      readonly endpoint: string | null
    }>()
    expectTypeOf<HeartbeatResponse>().toEqualTypeOf<{
      readonly accepted: true
      readonly nextInSec: number
      readonly epoch?: number
      readonly ownerId?: string
      readonly revoked?: {
        readonly sessions: readonly string[]
        readonly clients: readonly string[]
      }
    }>()
    expectTypeOf<HealthResponse>().toEqualTypeOf<{
      readonly ok: true
      readonly version: string
      readonly configured: boolean
    }>()
  })

  it('keeps every client and grant wire type', () => {
    expectTypeOf<ClientRegisterRequest>().toEqualTypeOf<{ readonly label: string }>()
    expectTypeOf<ClientRegisterResponse>().toEqualTypeOf<{
      readonly client: { readonly id: string; readonly label: string }
    }>()
    expectTypeOf<GrantIssueRequest>().toEqualTypeOf<{
      readonly hostId: string
      readonly clientId: string
    }>()
    expectTypeOf<GrantIssueResponse>().toEqualTypeOf<{
      readonly grant: string
      readonly expiresAt: string
      readonly host: {
        readonly id: string
        readonly endpoint: string | null
        readonly publicKey: string
      }
    }>()
    expectTypeOf<HostRevocations>().toEqualTypeOf<{
      readonly epoch: number
      readonly ownerId: string
      readonly revoked: {
        readonly sessions: readonly string[]
        readonly clients: readonly string[]
      }
    }>()
  })
})

describe('signed bytes', () => {
  it('builds the interop vector byte for byte and signs it to the recorded signature', () => {
    const text = api.hostSigningString(vector.input)
    expect(text).toBe(vector.signingString)
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(
      'bbdcc630376c1e892abae25af6608bcfe0f0b34afa19e1279da9f60cd7cfeabd',
    )
    const privateKey = createPrivateKey({
      key: Buffer.from(vector.pkcs8Hex, 'hex'),
      format: 'der',
      type: 'pkcs8',
    })
    expect(sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64url')).toBe(
      vector.signature,
    )
  })

  it('joins seven fields with LF, uppercases only the method and copies the rest verbatim', () => {
    const input = {
      method: 'patch',
      path: '/api/v1/Machines/x y',
      identity: 'id\twith tab',
      timestamp: '0',
      nonce: 'a\nb',
      bodySha256: '',
    }
    const text = api.hostSigningString(input)
    expect(text).toBe('phosphor-host-v1\nPATCH\n/api/v1/Machines/x y\nid\twith tab\n0\na\nb\n')
    expect(text.split('\n')).toHaveLength(8)
    expect(api.hostSigningString({ ...input, method: 'Get', nonce: 'n' }).split('\n')[1]).toBe(
      'GET',
    )
    expect(api.hostSigningString({ ...input, extra: 'ignored' } as typeof input)).toBe(text)
  })

  it('formats the first eight digest bytes and recognises only that form', () => {
    expect(api.formatKeyFingerprint(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]))).toBe(
      '0001-0203-0405-0607',
    )
    expect(api.formatKeyFingerprint(new Uint8Array(32).fill(0xab))).toBe('abab-abab-abab-abab')
    expect(() => api.formatKeyFingerprint(new Uint8Array(7))).toThrow(
      'fingerprint needs 8 digest bytes',
    )
    expect(api.isKeyFingerprint(vector.keyFingerprint)).toBe(true)
    for (const bad of [
      '65B6-0673-d6ed-884b',
      '65b6-0673-d6ed',
      '65b60673d6ed884b',
      ' 65b6-0673-d6ed-884b',
    ])
      expect(api.isKeyFingerprint(bad)).toBe(false)
    expect(api.isKeyFingerprint(42)).toBe(false)
  })
})

describe('canonical base64url', () => {
  it('accepts only a last character whose unused bits are zero', () => {
    expect(lastChars(api.isPublicKey, 43)).toBe('AEIMQUYcgkosw048')
    expect(lastChars(api.isSignature, 86)).toBe('AQgw')
    expect(lastChars(api.isNonce, 22)).toBe('AQgw')
    expect(api.isPublicKey(vector.publicKey)).toBe(true)
    expect(api.isSignature(vector.signature)).toBe(true)
    expect(api.isNonce(vector.input.nonce)).toBe(true)
  })

  it('refuses other lengths, padding, the standard alphabet and non-strings', () => {
    for (const [check, length] of [
      [api.isPublicKey, 43],
      [api.isSignature, 86],
      [api.isNonce, 22],
    ] as const) {
      expect(check('A'.repeat(length))).toBe(true)
      for (const bad of [
        'A'.repeat(length - 1),
        'A'.repeat(length + 1),
        `${'A'.repeat(length - 1)}=`,
        `${'A'.repeat(length)}=`,
        `+${'A'.repeat(length - 1)}`,
        `/${'A'.repeat(length - 1)}`,
        `é${'A'.repeat(length - 1)}`,
        `${'A'.repeat(length - 2)}😀`,
        null,
        length,
        [...'A'.repeat(length)],
      ])
        expect(check(bad)).toBe(false)
    }
  })

  it('takes lowercase sha256 hex only', () => {
    expect(api.isSha256Hex(vector.input.bodySha256)).toBe(true)
    for (const bad of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null])
      expect(api.isSha256Hex(bad)).toBe(false)
  })
})

describe('timestamps and skew', () => {
  it('parses unix seconds as 1-12 digits with no sign, space or leading zero', () => {
    expect(api.parseTimestamp('1')).toBe(1)
    expect(api.parseTimestamp('999999999999')).toBe(999_999_999_999)
    expect(api.parseTimestamp(vector.input.timestamp)).toBe(1_792_000_000)
    const refused = '0 01 1000000000000 +1 -1 1e3 1.0 0x1'.split(' ')
    for (const bad of [...refused, ' 1', '1\n', '', 1, null])
      expect(api.parseTimestamp(bad)).toBeNull()
  })

  it('allows exactly sixty seconds either way, measured from fractional milliseconds', () => {
    const now = 1_792_000_000_500
    expect(api.withinSkew(1_792_000_060, now)).toBe(true)
    expect(api.withinSkew(1_792_000_061, now)).toBe(false)
    expect(api.withinSkew(1_791_999_941, now)).toBe(true)
    expect(api.withinSkew(1_791_999_940, now)).toBe(false)
    expect(api.withinSkew(1_792_000_060, 1_792_000_000_000)).toBe(true)
    expect(api.withinSkew(1_791_999_940, 1_792_000_000_000)).toBe(true)
    expect(api.withinSkew(Number.NaN, now)).toBe(false)
  })
})

describe('user codes', () => {
  it('maps every byte below 240 to one letter and skips the rest', () => {
    for (let byte = 0; byte < 256; byte++) {
      const code = api.userCodeFromBytes(new Uint8Array(8).fill(byte))
      expect(code).toBe(byte < 240 ? api.USER_CODE_ALPHABET[byte % 20]!.repeat(8) : null)
    }
  })

  it('stops at eight letters and reports exhaustion as null', () => {
    const bytes = Uint8Array.from([255, 0, 240, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(api.userCodeFromBytes(bytes)).toBe('BCDFGHJK')
    expect(api.userCodeFromBytes(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 250]))).toBeNull()
    expect(api.userCodeFromBytes(new Uint8Array(0))).toBeNull()
  })

  it('forgives case, whitespace and dashes within 32 input characters, and nothing else', () => {
    expect(api.normalizeUserCode(`${'-'.repeat(24)}bcdfghjk`)).toBe('BCDFGHJK')
    expect(api.normalizeUserCode(`${'-'.repeat(25)}bcdfghjk`)).toBeNull()
    expect(api.normalizeUserCode('\tBCDF\nGHJK\u00a0')).toBe('BCDFGHJK')
    expect(api.normalizeUserCode('BCDFGHß')).toBe('BCDFGHSS')
    for (const bad of ['BCDF_GHJK', 'BCDF.GHJK', 'BCDFGHJA', 'BCDFGHJKB', '', 12345678, null])
      expect(api.normalizeUserCode(bad)).toBeNull()
    expect(api.formatUserCode('BCDFGHJK')).toBe('BCDF-GHJK')
    expect(api.formatUserCode('BCD')).toBe('BCD-')
  })
})

describe('field rules', () => {
  it('trims labels with String.prototype.trim and counts UTF-16 units', () => {
    expect(api.normalizeLabel('\u2028 bee1 \u00a0\ufeff')).toBe('bee1')
    expect(api.normalizeLabel('🐝'.repeat(40))).toBe('🐝'.repeat(40))
    expect(api.normalizeLabel(`${'🐝'.repeat(40)}a`)).toBeNull()
    expect(api.normalizeLabel(`  ${'x'.repeat(80)}  `)).toBe('x'.repeat(80))
    for (const bad of ['', ' \t\n ', 'x'.repeat(81), null, 1, ['bee']])
      expect(api.normalizeLabel(bad)).toBeNull()
  })

  it('refuses control characters and display-changing marks inside a label', () => {
    const refused = [
      ...Array.from({ length: 0x20 }, (_, code) => code),
      ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
      0x061c,
      0x200e,
      0x200f,
      ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e],
      ...[0x2066, 0x2067, 0x2068, 0x2069],
      0x2028,
      0x2029,
    ]
    for (const code of refused)
      expect(api.normalizeLabel(`a${String.fromCodePoint(code)}b`), code.toString(16)).toBeNull()
    for (const code of [0x7e, 0xa0, 0xad, 0x061b, 0x200b, 0x200d, 0x202f, 0x2065, 0x206a])
      expect(api.normalizeLabel(`a${String.fromCodePoint(code)}b`)).toBe(
        `a${String.fromCodePoint(code)}b`,
      )
  })

  it('takes hostnames of 1-253 characters that start alphanumeric', () => {
    for (const good of ['a', '9', `a${'b'.repeat(252)}`, 'bee_1.local.', 'A-.'])
      expect(api.isHostname(good)).toBe(true)
    for (const bad of ['', `a${'b'.repeat(253)}`, '-a', '.a', '_a', 'a b', 'bé', null])
      expect(api.isHostname(bad)).toBe(false)
  })

  it('takes three bounded version numbers and an optional bounded suffix', () => {
    for (const good of [
      '0.0.0',
      '123456.123456.123456',
      '1.2.3+build.7',
      `1.2.3-${'a'.repeat(64)}`,
    ])
      expect(api.isVersion(good)).toBe(true)
    for (const bad of [
      '1234567.0.0',
      '1.2',
      'v1.2.3',
      '1.2.3-',
      `1.2.3-${'a'.repeat(65)}`,
      '1.2.3_x',
      1,
    ])
      expect(api.isVersion(bad)).toBe(false)
  })

  it('takes bare lowercase HTTPS origins with ports 1-65535', () => {
    for (const good of [
      'https://a',
      'https://a.',
      `https://a${'b'.repeat(252)}`,
      'https://a:1',
      'https://a:65535',
    ])
      expect(api.isEndpoint(good)).toBe(true)
    for (const bad of [
      `https://a${'b'.repeat(253)}`,
      'https://-a',
      'https://a:0',
      'https://a:01',
      'https://a:65536',
      'https://a:123456',
      'https://a_b',
      'https://a/',
      'HTTPS://a',
      'https://a\n',
      null,
    ])
      expect(api.isEndpoint(bad)).toBe(false)
  })

  it('takes UTC times exactly as toISOString writes them', () => {
    for (const good of [
      '0000-01-01T00:00:00.000Z',
      '9999-12-31T23:59:59.999Z',
      '2024-02-29T00:00:00.000Z',
    ])
      expect(api.isIsoTime(good)).toBe(true)
    for (const bad of [
      '2026-02-29T00:00:00.000Z',
      '2026-10-12T24:00:00.000Z',
      '2026-10-12t10:00:00.000z',
      0,
    ])
      expect(api.isIsoTime(bad)).toBe(false)
  })

  it('takes lowercase uuids with version 1-8 and variant 8-b', () => {
    const at = (version: string, variant: string) =>
      `0b6f7c1e-2f4a-${version}c8e-${variant}d1b-5a7e3c2f1d00`
    for (const version of '12345678') expect(api.isUuid(at(version, '9'))).toBe(true)
    for (const variant of '89ab') expect(api.isUuid(at('4', variant))).toBe(true)
    for (const bad of [
      at('0', '9'),
      at('9', '9'),
      at('4', '7'),
      at('4', 'c'),
      '00000000-0000-0000-0000-000000000000',
      ` ${ID}`,
      null,
    ])
      expect(api.isUuid(bad)).toBe(false)
  })
})

describe('unknown field projection', () => {
  const machine = {
    id: ID,
    label: 'bee1',
    hostname: 'bee1',
    platform: 'darwin',
    arch: 'arm64',
    hostVersion: '0.2.0',
    keyFingerprint: '0a1b-2c3d-4e5f-6a7b',
    enrolledAt: '2026-10-12T10:00:00.000Z',
    lastSeenAt: '2026-10-12T10:05:00.000Z',
    state: 'running',
    readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
    lanes: { running: 1, waiting: 0 },
    endpoint: 'https://bee1.ts.net',
  }
  const extra = { extra: 1, __unknown: 'x' }

  it('keeps only known request fields, with typed input normalized', () => {
    const create = {
      publicKey: KEY,
      hostname: 'bee1',
      platform: 'linux',
      arch: 'x64',
      hostVersion: '1.0.0',
    }
    expect(api.parseEnrollmentCreateRequest({ ...create, ...extra })).toStrictEqual({
      ok: true,
      value: create,
    })
    expect(api.parseEnrollmentPollRequest({ enrollmentId: ID, ...extra })).toStrictEqual({
      ok: true,
      value: { enrollmentId: ID },
    })
    expect(api.parseEnrollmentLookupRequest({ userCode: 'bcdf ghjk', ...extra })).toStrictEqual({
      ok: true,
      value: { userCode: 'BCDFGHJK' },
    })
    expect(
      api.parseEnrollmentApproveRequest({ userCode: 'bcdf-ghjk', label: ' bee ', ...extra }),
    ).toStrictEqual({ ok: true, value: { userCode: 'BCDFGHJK', label: 'bee' } })
    expect(api.parseMachineRenameRequest({ label: ' bee ', ...extra })).toStrictEqual({
      ok: true,
      value: { label: 'bee' },
    })
    expect(api.parseClientRegisterRequest({ label: ' bee ', ...extra })).toStrictEqual({
      ok: true,
      value: { label: 'bee' },
    })
    expect(api.parseGrantIssueRequest({ hostId: ID, clientId: ID, ...extra })).toStrictEqual({
      ok: true,
      value: { hostId: ID, clientId: ID },
    })
    const beat = {
      seq: 1,
      state: 'stopping',
      hostVersion: '1.0.0',
      uptimeSec: 0,
      readiness: machine.readiness,
      lanes: machine.lanes,
      endpoint: null,
    }
    const parsed = api.parseHeartbeatRequest({
      ...beat,
      ...extra,
      readiness: { ...beat.readiness, ...extra },
      lanes: { ...beat.lanes, ...extra },
    })
    expect(parsed).toStrictEqual({ ok: true, value: beat })
  })

  it('keeps only known response fields at every depth and copies arrays', () => {
    const nested = {
      ...machine,
      ...extra,
      readiness: { ...machine.readiness, ...extra },
      lanes: { ...machine.lanes, ...extra },
    }
    const list = { machines: [nested], serverTime: machine.enrolledAt, ...extra }
    const parsed = api.parseMachinesResponse(list)
    expect(parsed).toStrictEqual({
      ok: true,
      value: { machines: [machine], serverTime: machine.enrolledAt },
    })
    expect(parsed.ok && parsed.value.machines).not.toBe(list.machines)
    expect(api.parseEnrollmentApproveResponse({ machine: nested, ...extra })).toStrictEqual({
      ok: true,
      value: { machine },
    })
    const owner = { login: 'octo', ...extra }
    expect(
      api.parseMeResponse({ account: owner, enabled: false, maxHosts: 0, ...extra }),
    ).toStrictEqual({
      ok: true,
      value: { account: { login: 'octo' }, enabled: false, maxHosts: 0 },
    })
    expect(
      api.parseEnrollmentPollResponse({ status: 'expired', hostId: ID, ...extra }),
    ).toStrictEqual({ ok: true, value: { status: 'expired' } })
    expect(
      api.parseEnrollmentPollResponse({
        status: 'approved',
        hostId: ID,
        label: 'bee',
        owner,
        ...extra,
      }),
    ).toStrictEqual({
      ok: true,
      value: { status: 'approved', hostId: ID, label: 'bee', owner: { login: 'octo' } },
    })
    const self = {
      hostId: ID,
      label: 'bee',
      owner: { login: null },
      enrolledAt: machine.enrolledAt,
      lastSeenAt: null,
    }
    expect(api.parseHostSelfResponse({ ...self, ...extra })).toStrictEqual({
      ok: true,
      value: self,
    })
    expect(
      api.parseHealthResponse({ ok: true, version: '', configured: true, ...extra }),
    ).toStrictEqual({ ok: true, value: { ok: true, version: '', configured: true } })
    expect(
      api.parseControlError({ error: { code: 'gone', message: 'm', ...extra }, ...extra }),
    ).toStrictEqual({ error: { code: 'gone', message: 'm' } })
    expect(
      api.parseClientRegisterResponse({ client: { id: ID, label: 'bee', ...extra }, ...extra }),
    ).toStrictEqual({ ok: true, value: { client: { id: ID, label: 'bee' } } })
  })

  it('keeps only known grant and revocation fields, and omits absent heartbeat metadata', () => {
    const create = {
      enrollmentId: ID,
      userCode: 'BCDFGHJK',
      keyFingerprint: '0a1b-2c3d-4e5f-6a7b',
      expiresAt: machine.enrolledAt,
      pollIntervalSec: 60,
    }
    expect(api.parseEnrollmentCreateResponse({ ...create, ...extra })).toStrictEqual({
      ok: true,
      value: create,
    })
    const lookup = {
      hostname: 'bee1',
      platform: 'win32',
      arch: 'x64',
      hostVersion: '1.0.0',
      keyFingerprint: create.keyFingerprint,
      expiresAt: create.expiresAt,
    }
    expect(api.parseEnrollmentLookupResponse({ ...lookup, ...extra })).toStrictEqual({
      ok: true,
      value: lookup,
    })
    const grant = {
      grant: `phosphor-grant.v1.e30.${'A'.repeat(86)}`,
      expiresAt: create.expiresAt,
      host: { id: ID, endpoint: null, publicKey: KEY },
    }
    expect(
      api.parseGrantIssueResponse({ ...grant, ...extra, host: { ...grant.host, ...extra } }),
    ).toStrictEqual({ ok: true, value: grant })
    const sessions = [ID]
    const revocations = { epoch: 1, ownerId: ID, revoked: { sessions, clients: [] } }
    const parsed = api.parseHostRevocations({
      ...revocations,
      ...extra,
      revoked: { ...revocations.revoked, ...extra },
    })
    expect(parsed).toStrictEqual({ ok: true, value: revocations })
    expect(parsed.ok && parsed.value.revoked.sessions).not.toBe(sessions)
    const beat = api.parseHeartbeatResponse({ accepted: true, nextInSec: 10, ...extra })
    expect(beat).toStrictEqual({ ok: true, value: { accepted: true, nextInSec: 10 } })
    expect(beat.ok && Object.keys(beat.value)).toEqual(['accepted', 'nextInSec'])
    const full = api.parseHeartbeatResponse({
      accepted: true,
      nextInSec: 3600,
      ...revocations,
      ...extra,
    })
    expect(full.ok && Object.keys(full.value)).toEqual([
      'accepted',
      'nextInSec',
      'epoch',
      'ownerId',
      'revoked',
    ])
  })

  it('reads a JSON __proto__ key as data, never as inherited fields', () => {
    const body = (text: string): unknown => JSON.parse(text)
    expect(api.parseMachineRenameRequest(body('{"__proto__":{"label":"bee"}}'))).toStrictEqual({
      ok: false,
      reason: 'label',
    })
    expect(
      api.parseGrantIssueRequest(body(`{"__proto__":{"hostId":"${ID}","clientId":"${ID}"}}`)),
    ).toStrictEqual({ ok: false, reason: 'ids' })
    const label = api.parseMachineRenameRequest(body('{"label":"bee","__proto__":{"admin":true}}'))
    expect(label).toStrictEqual({ ok: true, value: { label: 'bee' } })
    expect(label.ok && Object.getPrototypeOf(label.value)).toBe(Object.prototype)
  })
})
