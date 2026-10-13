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
import { isEndpoint, isUuid, normalizeLabel, type Parsed } from './control-api'
import { HOST_CAPABILITIES, type HostCapability } from './remote-host'

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

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
export function encodeBase64url(bytes: Uint8Array): string {
  let out = ''
  let bits = 0,
    accumulator = 0
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += alphabet.charAt((accumulator >>> bits) & 63)
    }
  }
  if (bits) out += alphabet.charAt((accumulator << (6 - bits)) & 63)
  return out
}
export function decodeBase64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null
  const bytes = new Uint8Array(Math.floor((s.length * 6) / 8))
  let bits = 0,
    accumulator = 0,
    i = 0
  for (const c of s) {
    accumulator = (accumulator << 6) | alphabet.indexOf(c)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[i++] = (accumulator >>> bits) & 255
    }
  }
  return encodeBase64url(bytes) === s ? bytes : null
}
/** UTF-8 encoding without platform globals. JSON.stringify escapes lone surrogates. */
export function grantUtf8(s: string): Uint8Array {
  const bytes: number[] = []
  for (const c of s) {
    const cp = c.codePointAt(0)
    if (cp === undefined) continue
    const n = cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp
    if (n < 128) bytes.push(n)
    else if (n < 2048) bytes.push(192 | (n >> 6), 128 | (n & 63))
    else if (n < 65536) bytes.push(224 | (n >> 12), 128 | ((n >> 6) & 63), 128 | (n & 63))
    else bytes.push(240 | (n >> 18), 128 | ((n >> 12) & 63), 128 | ((n >> 6) & 63), 128 | (n & 63))
  }
  return new Uint8Array(bytes)
}
function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
function count(v: unknown, min = 0): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min
}
function kid(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
}
function fail<T>(reason: string): Parsed<T> {
  return { ok: false, reason }
}
function origin(v: unknown): v is string {
  if (isEndpoint(v)) return true
  if (typeof v !== 'string') return false
  const m = /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})$/.exec(v)
  return m !== null && Number(m[1]) <= 65535
}
export function parseGrantPayload(v: unknown): Parsed<GrantPayload> {
  if (!record(v) || v.v !== GRANT_VERSION) return fail('version')
  if (!origin(v.iss)) return fail('issuer')
  if (!kid(v.kid)) return fail('kid')
  if (!isUuid(v.sub) || !isUuid(v.sid) || !isUuid(v.hostId)) return fail('identity')
  if (!count(v.epoch)) return fail('epoch')
  if (
    !record(v.client) ||
    !isUuid(v.client.id) ||
    typeof v.client.label !== 'string' ||
    normalizeLabel(v.client.label) !== v.client.label
  )
    return fail('client')
  if (!Array.isArray(v.caps) || v.caps.length > HOST_CAPABILITIES.length)
    return fail('capabilities')
  const caps: HostCapability[] = []
  for (const c of v.caps) {
    const capability = HOST_CAPABILITIES.find((known) => known === c)
    if (capability === undefined || caps.includes(capability)) return fail('capabilities')
    caps.push(capability)
  }
  if (!count(v.iat) || !count(v.exp)) return fail('time')
  // toISOString is used by the wire adapter, so keep seconds in its representable range.
  if (v.iat > 253402300799 || v.exp > 253402300799) return fail('time')
  if (typeof v.jti !== 'string' || !/^[0-9a-f]{16}$/.test(v.jti)) return fail('jti')
  return {
    ok: true,
    value: {
      v: 1,
      iss: v.iss,
      kid: v.kid,
      sub: v.sub,
      sid: v.sid,
      hostId: v.hostId,
      epoch: v.epoch,
      client: { id: v.client.id, label: v.client.label },
      caps,
      iat: v.iat,
      exp: v.exp,
      jti: v.jti,
    },
  }
}
export function encodeGrant(
  payload: GrantPayload,
  sign: (bytes: Uint8Array) => Uint8Array,
): string {
  const parsed = parseGrantPayload(payload)
  if (!parsed.ok) throw new Error('Invalid grant payload')
  const bytes = grantUtf8(JSON.stringify(parsed.value))
  const signature = sign(bytes)
  if (signature.length !== 64) throw new Error('Invalid grant signature length')
  const token = GRANT_PREFIX + encodeBase64url(bytes) + '.' + encodeBase64url(signature)
  if (token.length > GRANT_LIMITS.tokenChars) throw new Error('Grant too large')
  return token
}
export function splitGrant(
  token: string,
): Parsed<{ payload: GrantPayload; payloadBytes: Uint8Array; signature: Uint8Array }> {
  if (token.length > GRANT_LIMITS.tokenChars || !token.startsWith(GRANT_PREFIX))
    return fail('token')
  const parts = token.slice(GRANT_PREFIX.length).split('.')
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return fail('parts')
  const bytes = decodeBase64url(parts[0]),
    signature = decodeBase64url(parts[1])
  if (!bytes || !signature || signature.length !== 64) return fail('encoding')
  try {
    const decoded = decodeURIComponent(
      Array.from(bytes, (b) => '%' + b.toString(16).padStart(2, '0')).join(''),
    )
    const value: unknown = JSON.parse(decoded)
    const payload = parseGrantPayload(value)
    return payload.ok
      ? { ok: true, value: { payload: payload.value, payloadBytes: bytes, signature } }
      : payload
  } catch {
    return fail('payload')
  }
}
export function checkGrantClaims(
  p: GrantPayload,
  expect: GrantExpectations,
  nowSec: number,
  skewSec: number,
): GrantClaimFailure | null {
  if (p.iss !== expect.iss) return 'issuer'
  if (p.hostId !== expect.hostId) return 'host'
  if (p.sub !== expect.owner) return 'owner'
  if (p.epoch !== expect.epoch) return 'epoch'
  if (p.exp <= p.iat || p.exp - p.iat > GRANT_LIMITS.ttlSec) return 'lifetime'
  if (
    !Number.isFinite(nowSec) ||
    !Number.isFinite(skewSec) ||
    skewSec < 0 ||
    nowSec < p.iat - skewSec
  )
    return 'not-yet-valid'
  if (nowSec >= p.exp + skewSec) return 'expired'
  if (expect.revokedSessions.has(p.sid)) return 'revoked-session'
  if (expect.revokedClients.has(p.client.id)) return 'revoked-client'
  return null
}
export function parseGrantKeySet(v: unknown): Parsed<GrantKeySet> {
  if (!record(v) || !Array.isArray(v.keys) || v.keys.length > 8) return fail('keys')
  const keys: { kid: string; publicKey: string }[] = []
  for (const k of v.keys) {
    if (
      !record(k) ||
      !kid(k.kid) ||
      keys.some((old) => old.kid === k.kid) ||
      typeof k.publicKey !== 'string' ||
      k.publicKey.length !== 43 ||
      decodeBase64url(k.publicKey)?.length !== 32
    )
      return fail('key')
    keys.push({ kid: k.kid, publicKey: k.publicKey })
  }
  return { ok: true, value: { keys } }
}
