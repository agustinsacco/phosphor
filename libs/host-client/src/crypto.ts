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
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
/** SHA-256 as lowercase hex, through platform crypto (Node ≥ 22 and secure browser contexts). */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)))
}
/** No fallback: identity randomness and proof verification require platform crypto. */
export const browserCrypto: IdentityCrypto = {
  randomUUID: () => globalThis.crypto.randomUUID(),
  randomHex: (bytes) => hex(globalThis.crypto.getRandomValues(new Uint8Array(bytes))),
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
