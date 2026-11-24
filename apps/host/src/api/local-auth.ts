import { createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto'
import {
  LOCAL_LIMITS,
  parseLocalCredential,
  type LocalCredentialPayload,
  type OwnerClientsFile,
} from '@phosphor/shared/host-local'
import type { ReadyOpFlag } from '@phosphor/shared/host-protocol'
import type { HostHello } from '@phosphor/shared/remote-host'
import type { ConnectionAuthenticator } from './grant-auth'
import { principalCapabilities, type ConnectionPrincipal } from './principal'
import { readyFrame } from './ready-frame'

/** The socket hello's nonces: single use, `nonceTtlMs` old at most, `noncesOutstanding` at once. */
export interface LocalNonces {
  /** A fresh nonce, or null while `noncesOutstanding` unexpired nonces are unused. */
  issue(): string | null
  /** True once, for an issued nonce that has not expired. */
  consume(nonce: string): boolean
}

export function createLocalNonces(now: () => number = Date.now): LocalNonces {
  const issued = new Map<string, number>()
  function sweep() {
    const at = now()
    for (const [nonce, expires] of issued) if (expires <= at) issued.delete(nonce)
  }
  return {
    issue() {
      sweep()
      if (issued.size >= LOCAL_LIMITS.noncesOutstanding) return null
      const nonce = randomBytes(32).toString('hex')
      issued.set(nonce, now() + LOCAL_LIMITS.nonceTtlMs)
      return nonce
    },
    consume(nonce) {
      const expires = issued.get(nonce)
      issued.delete(nonce)
      return expires !== undefined && expires > now()
    },
  }
}

export interface LocalAuthPorts {
  /** The daemon's `local-identity.json` machine id; a credential for another machine is refused. */
  machineId: string
  /** The socket's hello now: its epoch and capabilities change once lanes start. */
  hello(): HostHello
  /** The local key (`local-key.pem`) that proves the ready frame. */
  key: KeyObject
  nonces: LocalNonces
  /** `owner-clients.json`, re-read on every auth so a new pairing needs no restart. */
  ownerClients(): OwnerClientsFile | null
  readyFlags?(): ReadonlySet<ReadyOpFlag>
  now?: () => number
}

/** Why a socket credential was refused; logged, never sent. */
export type LocalAuthRefusal =
  'token' | 'machine' | 'nonce' | 'stale' | 'owner-unknown' | 'signature' | 'identity'

function ownerKey(clients: OwnerClientsFile | null, id: string): KeyObject | null {
  const client = clients?.clients.find((known) => known.id === id)
  if (!client) return null
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: client.publicKey },
    format: 'jwk',
  })
}

function principalOf(payload: LocalCredentialPayload): ConnectionPrincipal {
  return payload.kind === 'owner'
    ? { kind: 'owner', clientId: payload.client.id }
    : {
        kind: 'local',
        clientId: payload.client.id,
        ...(payload.lane !== undefined ? { lane: payload.lane } : {}),
      }
}

/** A renewal keeps the first credential's kind, client and lane. */
function sameLocalIdentity(a: LocalCredentialPayload, b: LocalCredentialPayload): boolean {
  return a.kind === b.kind && a.client.id === b.client.id && a.lane === b.lane
}

type Checked =
  | { ok: true; payload: LocalCredentialPayload }
  | { ok: false; code: 4401 | 4403; reason: LocalAuthRefusal }

/**
 * Every check a socket credential passes: the `phosphor-local.` shape (so a
 * `phosphor-grant.` token is refused), this machine, a nonce this socket issued
 * and not yet used, `iat` within skew, and for an owner a signature by a paired
 * key. Every presented nonce is spent, even by a credential that then fails.
 */
function checkCredential(ports: LocalAuthPorts, token: string, nowMs: number): Checked {
  const parsed = parseLocalCredential(token)
  if (!parsed.ok) return { ok: false, code: 4401, reason: 'token' }
  const { payload, payloadBytes, signature } = parsed.value
  const fresh = ports.nonces.consume(payload.nonce)
  if (payload.machineId !== ports.machineId) return { ok: false, code: 4403, reason: 'machine' }
  if (!fresh) return { ok: false, code: 4401, reason: 'nonce' }
  if (Math.abs(nowMs / 1000 - payload.iat) > LOCAL_LIMITS.iatSkewSec)
    return { ok: false, code: 4401, reason: 'stale' }
  if (payload.kind === 'owner') {
    const key = ownerKey(ports.ownerClients(), payload.client.id)
    if (!key) return { ok: false, code: 4403, reason: 'owner-unknown' }
    if (!signature || !verify(null, payloadBytes, key, signature))
      return { ok: false, code: 4401, reason: 'signature' }
  }
  return { ok: true, payload }
}

/**
 * One socket connection's credentials. The owner is the attested Desktop;
 * everyone else on the socket is `local`. Nothing here depends on control, so
 * a 410 or a new enrollment never closes a socket connection.
 */
export function createLocalAuth(ports: LocalAuthPorts): ConnectionAuthenticator {
  const now = ports.now ?? Date.now
  let first: LocalCredentialPayload | undefined
  return {
    watch: () => () => {},
    async verify(token, challenge, outcome) {
      const at = now()
      const checked = checkCredential(ports, token, at)
      if (!checked.ok) return outcome.refuse(checked.code, checked.reason)
      const { payload } = checked
      if (first && (!sameLocalIdentity(first, payload) || challenge !== undefined))
        return outcome.refuse(4403, 'identity')
      if (!first && !outcome.admit(payload.client.id)) return outcome.refuse(4429, 'connections')
      first = payload
      const principal = principalOf(payload)
      const hello = ports.hello()
      const caps = principalCapabilities(hello, principal)
      const expiresAt = at + LOCAL_LIMITS.grantTtlSec * 1000
      const grantExpiresAt = new Date(expiresAt).toISOString()
      const owner = principal.kind === 'owner'
      outcome.accept({
        client: payload.client,
        principal,
        caps,
        closeAt: expiresAt + LOCAL_LIMITS.iatSkewSec * 1000,
        grantExpiresAt,
        ready: (answered, connectionId) =>
          readyFrame({
            hello,
            grant: { caps, ...(owner ? { configure: true } : {}), client: payload.client },
            key: ports.key,
            challenge: answered,
            connectionId,
            grantExpiresAt,
            caps,
            flags: ports.readyFlags?.(),
            ownerLocal: owner,
          }),
      })
    },
  }
}
