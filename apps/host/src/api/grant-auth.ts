import { verify, type KeyObject } from 'node:crypto'
import { CONTROL_LIMITS } from '@phosphor/shared/control-api'
import {
  checkGrantClaims,
  grantPrincipal,
  sameGrantIdentity,
  splitGrant,
  type GrantClient,
  type GrantPayload,
} from '@phosphor/shared/host-grant'
import type { HostCloseCode, HostFrame, ReadyOpFlag } from '@phosphor/shared/host-protocol'
import type { HostCapability, HostHello } from '@phosphor/shared/remote-host'
import type { Authority } from './authority'
import type { Keyset } from './keyset'
import { grantedCapabilities, readyFrame } from './ready-frame'
import { grantConnectionPrincipal, type ConnectionPrincipal } from './principal'

/** A credential a connection accepted: who it is, what it may do and until when. */
export interface Authentication {
  client: GrantClient
  principal: ConnectionPrincipal
  caps: readonly HostCapability[]
  /** Epoch milliseconds at which the credential lapses, clock skew included. */
  closeAt: number
  grantExpiresAt: string
  /** The ready frame that answers a first authentication's challenge. */
  ready(challenge: string, connectionId: string): Extract<HostFrame, { type: 'ready' }>
}

/** How one auth frame ends. The connection carries out the decision. */
export interface AuthOutcome {
  /** Checked after each await: a result that arrives after close is dropped silently. */
  ended(): boolean
  refuse(code: HostCloseCode, reason: string): void
  /** Admits a first authentication; false refuses it with 4429. */
  admit(clientId: string): boolean
  accept(authentication: Authentication): void
}

/** A connection's authentication: it verifies auth frames and watches what admitted them. */
export interface ConnectionAuthenticator {
  verify(token: string, challenge: string | undefined, outcome: AuthOutcome): Promise<void>
  /** Calls `lost` once the authority no longer admits the connection; returns the unsubscribe. */
  watch(lost: () => void): () => void
}

export interface GrantAuthPorts {
  authority: Authority
  keyset: Keyset
  origin: string
  hello: HostHello
  key: KeyObject
  /** Announced in ready when the machine runs the local service. */
  warmOnOpen?: boolean
  /** Announced in ready when the Host sends Web Push. */
  webPushKey?: string
  /** Announced in ready; none until the Host serves agent control. */
  readyFlags?: ReadonlySet<ReadyOpFlag>
  now?: () => number
}

type AuthoritySnapshot = NonNullable<ReturnType<Authority['snapshot']>>

/** An accepted grant against a later authority: same owner and epoch, unrevoked, origin still open. */
function stillAdmitted(grant: GrantPayload, authority: AuthoritySnapshot): boolean {
  return (
    grant.sub === authority.owner &&
    grant.epoch === authority.epoch &&
    !authority.revokedSessions.has(grant.sid) &&
    !authority.revokedClients.has(grant.client.id) &&
    (grant.origin !== 'machine' || authority.machineOrigin === true)
  )
}

/**
 * One connection's control-signed grants. The first grant fixes the
 * connection's owner, client, origin and machine; a renewal must keep all four
 * and carry no challenge. A changed owner or epoch, or a revoked session or
 * client, ends it; so does the Host dropping its machine opt-in, for a machine
 * grant. A machine grant also holds one of the authority's machine socket
 * slots until the watch ends.
 */
export function createGrantAuth(ports: GrantAuthPorts): ConnectionAuthenticator {
  const now = ports.now ?? Date.now
  let grant: GrantPayload | undefined
  let releaseMachine: (() => void) | undefined
  return {
    watch(lost) {
      const admittedAuthority = ports.authority.snapshot()
      const unsubscribe = ports.authority.onChange(() => {
        const authority = ports.authority.snapshot()
        if (
          !authority ||
          authority.owner !== admittedAuthority?.owner ||
          authority.epoch !== admittedAuthority?.epoch
        )
          lost()
        else if (grant && !stillAdmitted(grant, authority)) lost()
      })
      return () => {
        unsubscribe()
        releaseMachine?.()
      }
    },
    async verify(token, challenge, outcome) {
      const parsed = splitGrant(token)
      if (!parsed.ok) return outcome.refuse(4401, 'token')
      const { payload, payloadBytes, signature } = parsed.value
      const key = await ports.keyset.get(payload.kid)
      if (outcome.ended()) return
      if (!key || !verify(null, payloadBytes, key, signature))
        return outcome.refuse(4401, 'signature')
      const authority = ports.authority.snapshot()
      if (!authority) return outcome.refuse(4403, 'authority')
      const failure = checkGrantClaims(
        payload,
        { ...authority, iss: ports.origin, hostId: ports.hello.hostId },
        now() / 1000,
        CONTROL_LIMITS.signatureSkewSec,
      )
      if (failure)
        return outcome.refuse(
          failure === 'expired' || failure === 'not-yet-valid' ? 4401 : 4403,
          failure,
        )
      if (grant && (!sameGrantIdentity(grant, payload) || challenge !== undefined))
        return outcome.refuse(4403, 'identity')
      if (!grant && !outcome.admit(payload.client.id)) return outcome.refuse(4429, 'connections')
      if (!grant && payload.origin === 'machine') {
        const release = ports.authority.admitMachine()
        if (!release) return outcome.refuse(4429, 'machine-connections')
        releaseMachine = release
      }
      grant = payload
      const caps = grantedCapabilities(ports.hello, payload)
      const grantExpiresAt = new Date(payload.exp * 1000).toISOString()
      outcome.accept({
        client: payload.client,
        principal: grantConnectionPrincipal(grantPrincipal(payload)),
        caps,
        closeAt: (payload.exp + CONTROL_LIMITS.signatureSkewSec) * 1000,
        grantExpiresAt,
        ready: (answered, connectionId) =>
          readyFrame({
            hello: ports.hello,
            grant: payload,
            key: ports.key,
            challenge: answered,
            connectionId,
            grantExpiresAt,
            caps,
            webPushKey: ports.webPushKey,
            warmOnOpen: ports.warmOnOpen,
            flags: ports.readyFlags,
          }),
      })
    },
  }
}
