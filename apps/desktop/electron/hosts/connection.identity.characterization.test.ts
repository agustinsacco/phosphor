import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { grantUtf8 } from '@shared/host-grant'
import { helloProofMessage } from '@shared/host-protocol'
import { desktopIdentity } from './connection'

/** Desktop's Node identity as remote-lanes.ts and the Host connection use it. */
function hostKeys() {
  const keys = generateKeyPairSync('ed25519')
  const x = keys.publicKey.export({ format: 'jwk' }).x
  if (!x) throw new Error('No public key')
  return { x, privateKey: keys.privateKey }
}

describe('desktopIdentity', () => {
  it('draws v4 UUIDs and lowercase hex of the asked byte length', () => {
    expect(desktopIdentity.randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(desktopIdentity.randomHex(8)).toMatch(/^[0-9a-f]{16}$/)
    expect(desktopIdentity.randomHex(32)).toMatch(/^[0-9a-f]{64}$/)
    expect(desktopIdentity.randomHex(8)).not.toBe(desktopIdentity.randomHex(8))
  })

  it('verifies a ready proof over the hello message with the JWK x key, synchronously', () => {
    const host = hostKeys()
    const message = grantUtf8(helloProofMessage('host-id', 'epoch', 'a'.repeat(64)))
    const proof = sign(null, message, host.privateKey).toString('base64url')
    expect(desktopIdentity.verify(host.x, message, proof)).toBe(true)
    const other = grantUtf8(helloProofMessage('host-id', 'epoch', 'b'.repeat(64)))
    expect(desktopIdentity.verify(host.x, other, proof)).toBe(false)
    expect(desktopIdentity.verify(hostKeys().x, message, proof)).toBe(false)
  })

  it('answers false for a short proof and throws for a key that is not a JWK x value', () => {
    const host = hostKeys()
    const message = grantUtf8('message')
    expect(desktopIdentity.verify(host.x, message, 'AAAA')).toBe(false)
    const proof = sign(null, message, host.privateKey).toString('base64url')
    expect(() => desktopIdentity.verify('not a key', message, proof)).toThrow()
  })
})
