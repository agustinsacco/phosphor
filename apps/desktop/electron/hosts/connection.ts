import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { createHostConnection as createPortableConnection } from '@phosphor/host-client/connection'
import type { IdentityCrypto } from '@phosphor/host-client/crypto'
import { hostEndpoint as portableEndpoint } from '@phosphor/host-client/connection'
import { isEndpoint } from '@shared/control-api'
export function hostEndpoint(value: unknown, testEndpoint?: string): value is string {
  return portableEndpoint(value) || (isEndpoint(value) && value === testEndpoint)
}
export type {
  HostConnectionSnapshot,
  NotSent,
  CommandResult,
  LaneFrame,
} from '@phosphor/host-client/connection'

/** Desktop retains synchronous Node proof verification and cryptographic randomness. */
export const desktopIdentity: IdentityCrypto = {
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
export function createHostConnection(
  ports: Omit<
    Parameters<typeof createPortableConnection>[0],
    'identity' | 'endpointAllowed' | 'unrefTimer'
  > & { testEndpoint?: string },
) {
  return createPortableConnection({
    ...ports,
    identity: desktopIdentity,
    endpointAllowed: (value) => hostEndpoint(value, ports.testEndpoint),
    unrefTimer: (timer) => timer.unref(),
  })
}
