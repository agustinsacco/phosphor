import { sign, type KeyObject } from 'node:crypto'
import type { GrantPayload, GrantClient } from '@phosphor/shared/host-grant'
import {
  HOST_PROTOCOL_VERSION,
  helloProofMessage,
  type HostFrame,
  type ReadyOpFlag,
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

/** Each served op flag as `true`, and `ownerLocal` on the owner's own connection. */
function readyOpFlags(flags: ReadonlySet<ReadyOpFlag>, ownerLocal: boolean) {
  const served: Partial<Record<ReadyOpFlag, true>> = {}
  for (const flag of flags) if (flag !== 'ownerLocal') served[flag] = true
  if (ownerLocal) served.ownerLocal = true
  return served
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
  webPushKey?: string
  /** The agent-control features this Host serves; none announces nothing new. */
  flags?: ReadonlySet<ReadyOpFlag>
  /** The machine runs the local service, regardless of the connection transport. */
  warmOnOpen?: boolean
  /** The connection is the machine's owner on its local socket. */
  ownerLocal?: boolean
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
    machineShell: hello.capabilities.includes('terminal'),
    laneMarks: true,
    ...(options.flags?.has('ops') ? { laneRename: true } : {}),
    partialModels: true,
    ...(options.warmOnOpen ? { warmOnOpen: true } : {}),
    laneArchive: true,
    laneTransfer: true,
    fileBytes: true,
    prStatus: true,
    ...(options.webPushKey ? { webPushKey: options.webPushKey } : {}),
    prTracking: true,
    ...readyOpFlags(options.flags ?? new Set(), options.ownerLocal === true),
    proof: hostProof(hello, options.challenge, options.key),
    connectionId: options.connectionId,
    grantExpiresAt: options.grantExpiresAt,
    client: grant.client,
    capabilities: options.caps,
  }
}
