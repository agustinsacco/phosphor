import { sign, type KeyObject } from 'node:crypto'
import type { GrantPayload, GrantClient } from '@phosphor/shared/host-grant'
import {
  HOST_PROTOCOL_VERSION,
  helloProofMessage,
  type HostFrame,
} from '@phosphor/shared/host-protocol'
import type { HostHello, HostCapability } from '@phosphor/shared/remote-host'

type ConfigurationGrant = Pick<GrantPayload, 'caps' | 'configure'>

export function hostProof(hello: HostHello, challenge: string, key: KeyObject) {
  return sign(
    null,
    Buffer.from(helloProofMessage(hello.hostId, hello.runtimeEpoch, challenge)),
    key,
  ).toString('base64url')
}

export function grantedCapabilities(hello: HostHello, grant: ConfigurationGrant) {
  return hello.capabilities.filter(
    (cap) => grant.caps.includes(cap) || (cap === 'machine.configure' && grant.configure === true),
  )
}

/** Old clients see settings support without an unknown capability until signed opt-in. */
export function readyFrame(options: {
  hello: HostHello
  grant: ConfigurationGrant & { client: GrantClient }
  key: KeyObject
  challenge: string
  connectionId: string
  grantExpiresAt: string
  caps: readonly HostCapability[]
}): Extract<HostFrame, { type: 'ready' }> {
  const { hello, grant } = options
  return {
    type: 'ready',
    protocolVersion: HOST_PROTOCOL_VERSION,
    hello: {
      ...hello,
      capabilities: hello.capabilities.filter(
        (cap) =>
          cap !== 'machine.configure' || grant.configure === true || grant.caps.includes(cap),
      ),
    },
    settings: hello.capabilities.includes('machine.configure'),
    proof: hostProof(hello, options.challenge, options.key),
    connectionId: options.connectionId,
    grantExpiresAt: options.grantExpiresAt,
    client: grant.client,
    capabilities: options.caps,
  }
}
