import { verify, type KeyObject } from 'node:crypto'
import { CONTROL_LIMITS } from '@phosphor/shared/control-api'
import {
  checkGrantClaims,
  splitGrant,
  type GrantClient,
  type GrantPayload,
} from '@phosphor/shared/host-grant'
import type { HostCloseCode, HostFrame } from '@phosphor/shared/host-protocol'
import type { HostCapability, HostHello } from '@phosphor/shared/remote-host'
import type { Authority } from './authority'
import type { Keyset } from './keyset'
import { grantedCapabilities, readyFrame } from './ready-frame'

/** A credential a connection accepted: who it is, what it may do and until when. */
export interface Authentication {
  client: GrantClient
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
  /** Announced in ready when the Host sends Web Push. */
  webPushKey?: string
  now?: () => number
}

/**
 * One connection's control-signed grants. The first grant fixes the
 * connection's owner and client; a renewal must keep both and carry no
 * challenge. A changed owner or epoch, or a revoked session or client, ends it.
 */
export function createGrantAuth(ports: GrantAuthPorts): ConnectionAuthenticator {
  const now = ports.now ?? Date.now
  let grant: GrantPayload | undefined
  return {
    watch(lost) {
      const admittedAuthority = ports.authority.snapshot()
      return ports.authority.onChange(() => {
        const authority = ports.authority.snapshot()
        if (
          !authority ||
          authority.owner !== admittedAuthority?.owner ||
          authority.epoch !== admittedAuthority?.epoch
        )
          lost()
        else if (
          grant &&
          (!authority ||
            grant.sub !== authority.owner ||
            grant.epoch !== authority.epoch ||
            authority.revokedSessions.has(grant.sid) ||
            authority.revokedClients.has(grant.client.id))
        )
          lost()
      })
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
      if (
        grant &&
        (grant.sub !== payload.sub ||
          grant.client.id !== payload.client.id ||
          challenge !== undefined)
      )
        return outcome.refuse(4403, 'identity')
      if (!grant && !outcome.admit(payload.client.id)) return outcome.refuse(4429, 'connections')
      grant = payload
      const caps = grantedCapabilities(ports.hello, payload)
      const grantExpiresAt = new Date(payload.exp * 1000).toISOString()
      outcome.accept({
        client: payload.client,
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
          }),
      })
    },
  }
}
