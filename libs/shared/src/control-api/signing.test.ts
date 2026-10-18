import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import vector from '../__fixtures__/control-signing-vector.json'
import * as facade from '../control-api'
import { CONTROL_LIMITS } from './constants'
import {
  HOST_HEADERS,
  HOST_SIGNATURE_SCHEME,
  formatKeyFingerprint,
  hostSigningString,
  isKeyFingerprint,
  isNonce,
  isPublicKey,
  isSha256Hex,
  isSignature,
  parseTimestamp,
  withinSkew,
} from './signing'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const CANONICAL = [
  { check: isNonce, bytes: 16, unusedBits: 4 },
  { check: isPublicKey, bytes: 32, unusedBits: 2 },
  { check: isSignature, bytes: 64, unusedBits: 4 },
] as const

describe('host signing', () => {
  it('reproduces the shared interop vector from the seed', () => {
    const privateKey = createPrivateKey({
      key: Buffer.from(vector.pkcs8Hex, 'hex'),
      format: 'der',
      type: 'pkcs8',
    })
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
    const raw = spki.subarray(spki.length - 32)
    const text = hostSigningString(vector.input)
    expect(text).toBe(vector.signingString)
    expect(text.startsWith(`${HOST_SIGNATURE_SCHEME}\n`)).toBe(true)
    expect(isSha256Hex(vector.input.bodySha256)).toBe(true)
    expect(raw.toString('base64url')).toBe(vector.publicKey)
    expect(formatKeyFingerprint(createHash('sha256').update(raw).digest())).toBe(
      vector.keyFingerprint,
    )
    expect(isKeyFingerprint(vector.keyFingerprint)).toBe(true)
    const signature = sign(null, Buffer.from(text), privateKey)
    expect(signature.toString('base64url')).toBe(vector.signature)
    expect(verify(null, Buffer.from(text), createPublicKey(privateKey), signature)).toBe(true)
  })

  it('accepts every encoder output and refuses each alias that decodes to the same bytes', () => {
    for (const { check, bytes, unusedBits } of CANONICAL) {
      for (const fill of [0x00, 0x5a, 0xff]) {
        const data = Buffer.alloc(bytes, fill)
        const text = data.toString('base64url')
        expect(check(text)).toBe(true)
        const last = ALPHABET.indexOf(text.charAt(text.length - 1))
        for (let extra = 1; extra < 2 ** unusedBits; extra++) {
          const alias = `${text.slice(0, -1)}${ALPHABET.charAt(last + extra)}`
          expect(Buffer.from(alias, 'base64url').equals(data)).toBe(true)
          expect(check(alias)).toBe(false)
        }
      }
    }
  })

  it('reads timestamps strictly and accepts the skew endpoints only', () => {
    const skew = CONTROL_LIMITS.signatureSkewSec
    const now = 1_792_000_000
    expect(parseTimestamp(String(now))).toBe(now)
    expect(parseTimestamp('0')).toBeNull()
    expect(parseTimestamp('1'.repeat(13))).toBeNull()
    expect(withinSkew(now + skew, now * 1000)).toBe(true)
    expect(withinSkew(now - skew, now * 1000)).toBe(true)
    expect(withinSkew(now + skew + 1, now * 1000)).toBe(false)
    expect(withinSkew(now - skew - 1, now * 1000)).toBe(false)
  })

  it('names the signed headers in lowercase', () => {
    expect(Object.values(HOST_HEADERS)).toEqual([
      'x-phosphor-host',
      'x-phosphor-key',
      'x-phosphor-timestamp',
      'x-phosphor-nonce',
      'x-phosphor-signature',
    ])
  })

  it('is what the control-api entry exports', () => {
    expect(facade.HOST_HEADERS).toBe(HOST_HEADERS)
    expect(facade.HOST_SIGNATURE_SCHEME).toBe(HOST_SIGNATURE_SCHEME)
    expect(facade.hostSigningString).toBe(hostSigningString)
    expect(facade.isPublicKey).toBe(isPublicKey)
    expect(facade.isSignature).toBe(isSignature)
    expect(facade.isNonce).toBe(isNonce)
    expect(facade.isSha256Hex).toBe(isSha256Hex)
    expect(facade.parseTimestamp).toBe(parseTimestamp)
    expect(facade.withinSkew).toBe(withinSkew)
    expect(facade.formatKeyFingerprint).toBe(formatKeyFingerprint)
    expect(facade.isKeyFingerprint).toBe(isKeyFingerprint)
  })
})
