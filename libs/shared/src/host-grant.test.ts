import { describe, expect, it } from 'vitest'
import { randomBytes, randomUUID, sign, verify, generateKeyPairSync } from 'node:crypto'
import {
  GRANT_LIMITS,
  GRANT_PREFIX,
  checkGrantClaims,
  decodeBase64url,
  encodeBase64url,
  encodeGrant,
  grantUtf8,
  parseGrantKeySet,
  parseGrantPayload,
  splitGrant,
  type GrantPayload,
  type GrantExpectations,
} from './host-grant'

const payload: GrantPayload = {
  v: 1,
  iss: 'https://control.example',
  kid: 'key',
  sub: randomUUID(),
  sid: randomUUID(),
  hostId: randomUUID(),
  epoch: 1,
  client: { id: randomUUID(), label: 'Viewer' },
  caps: ['sessions.read', 'sessions.control'],
  iat: 1000,
  exp: 1300,
  jti: '0123456789abcdef',
}
const expectations: GrantExpectations = {
  iss: payload.iss,
  hostId: payload.hostId,
  owner: payload.sub,
  epoch: payload.epoch,
  revokedSessions: new Set(),
  revokedClients: new Set(),
}
const signature = new Uint8Array(64)
const rawToken = (value: unknown) =>
  GRANT_PREFIX +
  encodeBase64url(grantUtf8(JSON.stringify(value))) +
  '.' +
  encodeBase64url(signature)

describe('host-grant', () => {
  it('encodes UTF-8 and canonical unpadded base64url without platform globals', () => {
    for (const text of ['', 'ASCII', 'é中😀', '\ud800', '\udc00'])
      expect(grantUtf8(text)).toEqual(new Uint8Array(Buffer.from(text)))
    for (let n = 0; n < 100; n++) {
      const bytes = randomBytes(n)
      const encoded = encodeBase64url(bytes)
      expect(encoded).toBe(bytes.toString('base64url'))
      expect(decodeBase64url(encoded)).toEqual(new Uint8Array(bytes))
    }
    for (const invalid of ['A', 'AA=', 'AA==', 'A+', 'A/', 'AB', 'AAB', ' AA', 'AA\n'])
      expect(decodeBase64url(invalid)).toBeNull()
  })
  it('signs exactly the sanitized payload bytes in field order and verifies a round trip', () => {
    const keys = generateKeyPairSync('ed25519')
    const token = encodeGrant(payload, (bytes) => sign(null, bytes, keys.privateKey))
    const result = splitGrant(token)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('No grant')
    expect(result.value.payload).toEqual(payload)
    expect(Buffer.from(result.value.payloadBytes).toString()).toBe(JSON.stringify(payload))
    expect(verify(null, result.value.payloadBytes, keys.publicKey, result.value.signature)).toBe(
      true,
    )
    expect(
      parseGrantPayload({
        ...payload,
        ignored: 'not echoed',
        client: { ...payload.client, ignored: true },
      }),
    ).toEqual({ ok: true, value: payload })
    expect(() => encodeGrant(payload, () => new Uint8Array(63))).toThrow('signature length')
    expect(() => encodeGrant({ ...payload, kid: '' }, () => signature)).toThrow('payload')
  })
  it.each([
    null,
    [],
    { v: 2 },
    { iss: 'http://control.example' },
    { iss: 'https://control.example/' },
    { iss: 'https://user@control.example' },
    { iss: 'https://control.example?secret' },
    { iss: 'http://localhost:0' },
    { iss: 'http://127.0.0.1:65536' },
    { kid: '' },
    { kid: 'x'.repeat(65) },
    { kid: 'bad.key' },
    { sub: 'bad' },
    { sid: 'bad' },
    { hostId: 'bad' },
    { epoch: -1 },
    { epoch: 1.5 },
    { epoch: Number.MAX_SAFE_INTEGER + 1 },
    { client: null },
    { client: { ...payload.client, id: 'bad' } },
    { client: { ...payload.client, label: '' } },
    { client: { ...payload.client, label: 'x'.repeat(81) } },
    { client: { ...payload.client, label: ' Viewer' } },
    { client: { ...payload.client, label: 'a\nb' } },
    { client: { ...payload.client, label: 'a\u202eb' } },
    { caps: null },
    { caps: ['unknown'] },
    { caps: ['sessions.read', 'sessions.read'] },
    { iat: -1 },
    { exp: 1.5 },
    { iat: 253402300800 },
    { exp: 253402300800 },
    { jti: 'ABCDEF0123456789' },
    { jti: 'a'.repeat(17) },
  ])('rejects malformed payload %#', (patch) => {
    const value = patch === null || Array.isArray(patch) ? patch : { ...payload, ...patch }
    expect(parseGrantPayload(value).ok).toBe(false)
  })
  it('accepts exact label, kid, time and local-origin boundaries', () => {
    for (const iss of [
      'https://control.example:65535',
      'http://localhost:65535',
      'http://127.0.0.1:1',
    ])
      expect(
        parseGrantPayload({
          ...payload,
          iss,
          kid: 'x'.repeat(64),
          epoch: 0,
          client: { ...payload.client, label: 'x'.repeat(80) },
          iat: 0,
          exp: 253402300799,
        }).ok,
      ).toBe(true)
  })
  it('rejects each token envelope error and accepts exactly the length cap', () => {
    const base = { ...payload, ignored: '' }
    let token = rawToken(base)
    // Unknown payload fields are ignored, but still count against the wire cap.
    while (token.length < GRANT_LIMITS.tokenChars) {
      base.ignored += ' '
      token = rawToken(base)
    }
    expect(token.length).toBe(GRANT_LIMITS.tokenChars)
    expect(splitGrant(token).ok).toBe(true)
    base.ignored += ' '
    const onePast = rawToken(base)
    expect(onePast.length).toBe(GRANT_LIMITS.tokenChars + 1)
    expect(splitGrant(onePast).ok).toBe(false)
    for (const invalid of [
      token.replace(GRANT_PREFIX, 'phosphor-grant.v2.'),
      GRANT_PREFIX,
      token + '.x',
      GRANT_PREFIX + 'AA.' + encodeBase64url(signature),
      rawToken({}),
      GRANT_PREFIX + '_w.' + encodeBase64url(signature),
      GRANT_PREFIX + 'e30.' + encodeBase64url(new Uint8Array(63)),
      GRANT_PREFIX + 'e30=.' + encodeBase64url(signature),
    ])
      expect(splitGrant(invalid).ok).toBe(false)
  })
  it('checks every claim, 300 vs 301 seconds, and inclusive/exclusive skew boundaries', () => {
    expect(checkGrantClaims(payload, expectations, 1000, 30)).toBeNull()
    expect(checkGrantClaims({ ...payload, exp: 1301 }, expectations, 1000, 30)).toBe('lifetime')
    expect(checkGrantClaims({ ...payload, exp: 1000 }, expectations, 1000, 30)).toBe('lifetime')
    expect(checkGrantClaims(payload, expectations, 970, 30)).toBeNull()
    expect(checkGrantClaims(payload, expectations, 969, 30)).toBe('not-yet-valid')
    expect(checkGrantClaims(payload, expectations, 1329, 30)).toBeNull()
    expect(checkGrantClaims(payload, expectations, 1330, 30)).toBe('expired')
    for (const now of [NaN, Infinity])
      expect(checkGrantClaims(payload, expectations, now, 30)).toBe('not-yet-valid')
    for (const skew of [-1, NaN, Infinity])
      expect(checkGrantClaims(payload, expectations, 1000, skew)).toBe('not-yet-valid')
    for (const [patch, reason] of [
      [{ iss: 'https://other.example' }, 'issuer'],
      [{ hostId: randomUUID() }, 'host'],
      [{ sub: randomUUID() }, 'owner'],
      [{ epoch: 2 }, 'epoch'],
    ] as const)
      expect(checkGrantClaims({ ...payload, ...patch }, expectations, 1000, 30)).toBe(reason)
    expect(
      checkGrantClaims(
        payload,
        { ...expectations, revokedSessions: new Set([payload.sid]) },
        1000,
        30,
      ),
    ).toBe('revoked-session')
    expect(
      checkGrantClaims(
        payload,
        { ...expectations, revokedClients: new Set([payload.client.id]) },
        1000,
        30,
      ),
    ).toBe('revoked-client')
  })
  it('bounds keysets, enforces unique kids and canonical 32-byte public keys', () => {
    const publicKey = encodeBase64url(randomBytes(32))
    const keys = Array.from({ length: 8 }, (_, i) => ({ kid: 'key' + i, publicKey }))
    expect(parseGrantKeySet({ keys })).toEqual({ ok: true, value: { keys } })
    for (const value of [
      null,
      {},
      { keys: null },
      { keys: [...keys, { kid: 'extra', publicKey }] },
      { keys: [keys[0], keys[0]] },
      { keys: [null] },
      { keys: [{ kid: '', publicKey }] },
      { keys: [{ kid: 'key', publicKey: 'x'.repeat(43) }] },
      { keys: [{ kid: 'key', publicKey: 'AA' }] },
    ])
      expect(parseGrantKeySet(value).ok).toBe(false)
  })
})
