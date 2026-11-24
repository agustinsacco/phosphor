import { createHostConnection as createPortableConnection } from '@phosphor/host-client/connection'
import type { IdentityCrypto } from '@phosphor/host-client/crypto'
import { hostEndpoint as portableEndpoint } from '@phosphor/host-client/connection'
import { nodeIdentity } from '@phosphor/session-runtime/pi/node-identity'
import { isEndpoint } from '@shared/control-api'
export function hostEndpoint(value: unknown, testEndpoint?: string): value is string {
  return portableEndpoint(value) || (isEndpoint(value) && value === testEndpoint)
}

/** Desktop retains synchronous Node proof verification and cryptographic randomness. */
export const desktopIdentity: IdentityCrypto = nodeIdentity
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
