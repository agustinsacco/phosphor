import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import vector from './__fixtures__/control-signing-vector.json'
import { formatKeyFingerprint, hostSigningString, isPublicKey, isSignature } from './control-api'

// The interop vector both edges test against: apps/host signs with it and
// apps/control verifies with it, so the two are proven to agree byte for
// byte without importing each other. Ed25519 is deterministic, so the
// signature is fixed by the seed and the signing string.
describe('control signing vector', () => {
  const privateKey = createPrivateKey({
    key: Buffer.from(vector.pkcs8Hex, 'hex'),
    format: 'der',
    type: 'pkcs8',
  })
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  const raw = spki.subarray(spki.length - 32)

  it('builds the recorded signing string from its parts', () => {
    expect(hostSigningString(vector.input)).toBe(vector.signingString)
    expect(createHash('sha256').update(vector.body).digest('hex')).toBe(vector.input.bodySha256)
  })

  it('derives the recorded public key, fingerprint and signature from the seed', () => {
    expect(raw.toString('base64url')).toBe(vector.publicKey)
    expect(isPublicKey(vector.publicKey)).toBe(true)
    expect(formatKeyFingerprint(createHash('sha256').update(raw).digest())).toBe(
      vector.keyFingerprint,
    )
    const signature = sign(null, Buffer.from(vector.signingString), privateKey)
    expect(signature.toString('base64url')).toBe(vector.signature)
    expect(isSignature(vector.signature)).toBe(true)
  })

  it('verifies only the exact signing string', () => {
    const publicKey = createPublicKey(privateKey)
    const signature = Buffer.from(vector.signature, 'base64url')
    expect(verify(null, Buffer.from(vector.signingString), publicKey, signature)).toBe(true)
    const tampered = vector.signingString.replace('/poll', '/approve')
    expect(verify(null, Buffer.from(tampered), publicKey, signature)).toBe(false)
  })
})
