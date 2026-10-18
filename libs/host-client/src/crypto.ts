import { decodeBase64url } from '@phosphor/shared/host-grant'

export class UnsupportedIdentityCrypto extends Error {
  constructor() {
    super('Ed25519 verification is unsupported.')
  }
}
export interface IdentityCrypto {
  randomUUID(): string
  randomHex(bytes: number): string
  verify(key: string, message: Uint8Array, proof: string): boolean | Promise<boolean>
}
/** No fallback: identity randomness and proof verification require platform crypto. */
export const browserCrypto: IdentityCrypto = {
  randomUUID: () => globalThis.crypto.randomUUID(),
  randomHex: (bytes) =>
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join(''),
  async verify(key, message, proof) {
    const signature = decodeBase64url(proof)
    if (!signature || signature.length !== 64) return false
    if (!globalThis.crypto?.subtle) throw new UnsupportedIdentityCrypto()
    try {
      const publicKey = await crypto.subtle.importKey(
        'jwk',
        { kty: 'OKP', crv: 'Ed25519', x: key },
        { name: 'Ed25519' },
        false,
        ['verify'],
      )
      return await crypto.subtle.verify(
        'Ed25519',
        publicKey,
        new Uint8Array(signature),
        new Uint8Array(message),
      )
    } catch (error) {
      if (error instanceof Error && error.name === 'NotSupportedError')
        throw new UnsupportedIdentityCrypto()
      return false
    }
  },
}
