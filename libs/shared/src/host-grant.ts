/**
 * Host grants: short-lived permission, signed by the control plane, for one
 * client to use one Host. Not a JWT: one fixed algorithm (Ed25519) and no
 * header, so there is no algorithm to negotiate or confuse.
 *
 *   phosphor-grant.v1.<base64url(payload JSON bytes)>.<base64url(signature over those bytes)>
 *
 * This module only shapes and parses grants. Signing (apps/control) and
 * verification (apps/host) use node:crypto in their own apps. A parsed grant
 * is NOT verified: the Host checks the signature, then every claim.
 *
 * Living contract: docs/remote-access.md ("Host grants").
 */
import type { HostCapability } from './remote-host'

export const GRANT_PREFIX = 'phosphor-grant.v1.'
export const GRANT_VERSION = 1

export const GRANT_LIMITS = {
  /** Whole token, characters. */
  tokenChars: 4096,
  /** `exp - iat`, seconds. Equals HOST_LIMITS.grantTtlSec. */
  ttlSec: 300,
  /** Key ids, characters ([A-Za-z0-9_-]). */
  kidChars: 64,
  /** Revoked session or client ids a heartbeat response may carry. */
  revocations: 100,
} as const

export interface GrantClient {
  /** UUID, minted once per Desktop install by the grant broker. */
  readonly id: string
  /** Shown to other viewers when this client controls a lane. */
  readonly label: string
}

export interface GrantPayload {
  readonly v: typeof GRANT_VERSION
  /** The control-plane origin that signed it. The Host compares it to its configured origin. */
  readonly iss: string
  readonly kid: string
  /** Owner's user id. */
  readonly sub: string
  /** Supabase session id; revoking it (sign-out) revokes the grant. */
  readonly sid: string
  readonly hostId: string
  /** The Host's enrollment epoch; a re-enrollment or removal bumps it. */
  readonly epoch: number
  readonly client: GrantClient
  readonly caps: readonly HostCapability[]
  /** Unix seconds. */
  readonly iat: number
  readonly exp: number
  /** 16 hex, unique per grant; logged, never reused as a secret. */
  readonly jti: string
}

/** What the Host knows about itself when it checks a grant's claims. */
export interface GrantExpectations {
  readonly iss: string
  readonly hostId: string
  readonly owner: string
  readonly epoch: number
  readonly revokedSessions: ReadonlySet<string>
  readonly revokedClients: ReadonlySet<string>
}

export type GrantClaimFailure =
  | 'issuer'
  | 'host'
  | 'owner'
  | 'epoch'
  | 'not-yet-valid'
  | 'expired'
  | 'lifetime'
  | 'revoked-session'
  | 'revoked-client'

/** Public keys the control plane publishes at `GET /api/v1/grant-keys`. */
export interface GrantKeySet {
  readonly keys: readonly { readonly kid: string; readonly publicKey: string }[]
}

// ---------- parsers and claim checks (wave 0 kit) ----------
// splitGrant, parseGrantPayload, checkGrantClaims and parseGrantKeySet go below.
