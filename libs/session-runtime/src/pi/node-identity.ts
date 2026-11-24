/**
 * The Node-side identity for a Host connection: synchronous Ed25519 proof
 * verification and `node:crypto` randomness. Desktop main and the daemon's
 * reach pool pass it explicitly, because `createHostConnection` defaults to
 * the browser's WebCrypto.
 */
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import type { IdentityCrypto } from '@phosphor/host-client/crypto'

export const nodeIdentity: IdentityCrypto = {
  randomUUID,
  randomHex: (bytes) => randomBytes(bytes).toString('hex'),
  verify: (key, message, proof) =>
    verify(
      null,
      message,
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' }),
      Buffer.from(proof, 'base64url'),
    ),
}
