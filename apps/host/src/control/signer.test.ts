import { createPrivateKey, createHash, verify, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONTROL_LIMITS, HOST_HEADERS, hostSigningString } from '@phosphor/shared/control-api'
import { freshKey, publicIdentity, signRequest } from './signer'

const value: unknown = JSON.parse(
  readFileSync('libs/shared/src/__fixtures__/control-signing-vector.json', 'utf8'),
)
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
if (
  !record(value) ||
  !record(value.input) ||
  typeof value.pkcs8Hex !== 'string' ||
  typeof value.publicKey !== 'string' ||
  typeof value.body !== 'string' ||
  typeof value.signature !== 'string' ||
  typeof value.signingString !== 'string' ||
  typeof value.keyFingerprint !== 'string' ||
  typeof value.input.path !== 'string' ||
  typeof value.input.timestamp !== 'string' ||
  typeof value.input.nonce !== 'string'
)
  throw new Error('Invalid signing fixture')
const vector = {
  pkcs8Hex: value.pkcs8Hex,
  publicKey: value.publicKey,
  body: value.body,
  signature: value.signature,
  signingString: value.signingString,
  keyFingerprint: value.keyFingerprint,
  input: { path: value.input.path, timestamp: value.input.timestamp, nonce: value.input.nonce },
}
const key = createPrivateKey({
  key: Buffer.from(vector.pkcs8Hex, 'hex'),
  type: 'pkcs8',
  format: 'der',
})
const input = {
  method: 'POST' as const,
  path: vector.input.path,
  identity: { publicKey: vector.publicKey },
  body: vector.body,
  key,
  now: () => Number(vector.input.timestamp) * 1000,
  random: () => Buffer.alloc(16, 7),
}

describe('Host signer', () => {
  it('reproduces the shared vector byte for byte', () => {
    expect(publicIdentity(key)).toEqual({
      publicKey: vector.publicKey,
      keyFingerprint: vector.keyFingerprint,
    })
    expect(signRequest(input)).toEqual({
      [HOST_HEADERS.key]: vector.publicKey,
      [HOST_HEADERS.timestamp]: vector.input.timestamp,
      [HOST_HEADERS.nonce]: vector.input.nonce,
      [HOST_HEADERS.signature]: vector.signature,
    })
    expect(
      verify(
        null,
        Buffer.from(vector.signingString),
        createPublicKey(key),
        Buffer.from(vector.signature, 'base64url'),
      ),
    ).toBe(true)
  })
  it('binds the enrolled id, method, path, timestamp, nonce and exact bytes', () => {
    const hostId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
    const headers = signRequest({
      ...input,
      method: 'GET',
      path: '/api/v1/hosts/self',
      identity: { hostId },
      body: '',
    })
    expect(headers[HOST_HEADERS.host]).toBe(hostId)
    expect(headers[HOST_HEADERS.key]).toBeUndefined()
    const signed = {
      method: 'GET',
      path: '/api/v1/hosts/self',
      identity: hostId,
      timestamp: vector.input.timestamp,
      nonce: vector.input.nonce,
      bodySha256: createHash('sha256').update('').digest('hex'),
    }
    const signature = Buffer.from(headers[HOST_HEADERS.signature] ?? '', 'base64url')
    expect(
      verify(null, Buffer.from(hostSigningString(signed)), createPublicKey(key), signature),
    ).toBe(true)
    for (const change of [
      { method: 'POST' },
      { path: '/api/v1/enrollments' },
      { identity: vector.publicKey },
      { timestamp: '1792000001' },
      { nonce: 'A'.repeat(22) },
      { bodySha256: '0'.repeat(64) },
    ]) {
      expect(
        verify(
          null,
          Buffer.from(hostSigningString({ ...signed, ...change })),
          createPublicKey(key),
          signature,
        ),
      ).toBe(false)
    }
  })
  it('refuses queries, dot segments, oversized bodies, invalid identities, clocks and nonce sources', () => {
    for (const path of [
      '/api/v1/hosts/self?x=1',
      '/api/v1/../hosts/self',
      '/api/v1/%2e/hosts',
      '/api/v1/hosts\\self',
      '/api/v1//hosts/self',
      '/api/v1/hosts/self/',
    ]) {
      expect(() => signRequest({ ...input, path })).toThrow('Invalid signed request')
    }
    expect(() =>
      signRequest({ ...input, body: 'x'.repeat(CONTROL_LIMITS.bodyBytes) }),
    ).not.toThrow()
    expect(() =>
      signRequest({ ...input, body: 'x'.repeat(CONTROL_LIMITS.bodyBytes + 1) }),
    ).toThrow()
    for (const identity of [{ hostId: '../x' }, { publicKey: 'a'.repeat(43) }])
      expect(() => signRequest({ ...input, identity })).toThrow('Invalid signing identity')
    for (const now of [NaN, 0, -1000, 1e20])
      expect(() => signRequest({ ...input, now: () => now })).toThrow('Invalid signing clock')
    expect(() =>
      signRequest({
        ...input,
        identity: { publicKey: vector.publicKey, hostId: '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00' },
      }),
    ).toThrow('Invalid signing identity')
    expect(() => signRequest({ ...input, random: () => Buffer.alloc(15) })).toThrow(
      'Invalid nonce source',
    )
    expect(publicIdentity(freshKey()).publicKey).toHaveLength(43)
  })
})
