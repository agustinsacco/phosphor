/**
 * Host request signing: the byte-exact string an Ed25519 Host signature
 * covers, and the canonical encodings of keys, signatures, nonces, digests,
 * timestamps and fingerprints. No crypto here: each edge signs and verifies.
 */

import { CONTROL_LIMITS } from './constants'

export const HOST_SIGNATURE_SCHEME = 'phosphor-host-v1'

/** Lowercase, as HTTP header names are compared case-insensitively. */
export const HOST_HEADERS = {
  /** An enrolled Host's id. Mutually exclusive with `key`. */
  host: 'x-phosphor-host',
  /** The Ed25519 public key, before enrollment completes. */
  key: 'x-phosphor-key',
  timestamp: 'x-phosphor-timestamp',
  nonce: 'x-phosphor-nonce',
  signature: 'x-phosphor-signature',
} as const

export interface HostSigningInput {
  readonly method: string
  /** Path only: signed routes take no query string. */
  readonly path: string
  /** The host id or the public key, whichever header the request carries. */
  readonly identity: string
  /** Unix seconds, as sent in x-phosphor-timestamp. */
  readonly timestamp: string
  readonly nonce: string
  /** Lowercase hex SHA-256 of the exact body bytes (of '' for no body). */
  readonly bodySha256: string
}

/**
 * The exact bytes an Ed25519 Host signature covers. Binding the identity, the
 * route and the body hash means a captured signature cannot be replayed on
 * another route, for another Host, or with another body; the timestamp and
 * nonce bound replays of the same request.
 */
export function hostSigningString(input: HostSigningInput): string {
  return [
    HOST_SIGNATURE_SCHEME,
    input.method.toUpperCase(),
    input.path,
    input.identity,
    input.timestamp,
    input.nonce,
    input.bodySha256,
  ].join('\n')
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * Exactly `bytes` bytes as unpadded base64url, in its one canonical spelling:
 * the bits the last character carries beyond the data must be zero. Without
 * that, one key has up to 16 spellings (ElmQ, ElmR, ElmS, ElmT decode alike),
 * and a uniqueness rule on the text would not be one on the key.
 */
function isBase64url(value: unknown, bytes: number): value is string {
  const chars = Math.ceil((bytes * 8) / 6)
  if (typeof value !== 'string' || value.length !== chars) return false
  for (const char of value) if (!BASE64URL.includes(char)) return false
  const unusedBits = chars * 6 - bytes * 8
  return BASE64URL.indexOf(value.charAt(chars - 1)) % 2 ** unusedBits === 0
}

/** Raw 32-byte Ed25519 public key, base64url without padding (43 chars). */
export const isPublicKey = (value: unknown): value is string => isBase64url(value, 32)
/** 64-byte Ed25519 signature, base64url without padding (86 chars). */
export const isSignature = (value: unknown): value is string => isBase64url(value, 64)
/** 16 random bytes, base64url without padding (22 chars). */
export const isNonce = (value: unknown): value is string => isBase64url(value, 16)
export const isSha256Hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

/** Unix seconds as decimal digits, no sign, no leading zero. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,11}$/.test(value)) return null
  return Number(value)
}

/** True when a signed request's timestamp is within the allowed skew. */
export function withinSkew(timestampSec: number, nowMs: number): boolean {
  return Math.abs(nowMs / 1000 - timestampSec) <= CONTROL_LIMITS.signatureSkewSec
}

/**
 * The fingerprint people compare between a Host's terminal and the approving
 * screen: the first 8 bytes of SHA-256(raw public key), as four hex groups.
 */
export function formatKeyFingerprint(sha256OfKey: Uint8Array): string {
  if (sha256OfKey.length < 8) throw new Error('fingerprint needs 8 digest bytes')
  const hex = Array.from(sha256OfKey.subarray(0, 8), (b) => b.toString(16).padStart(2, '0'))
  return [0, 2, 4, 6].map((i) => `${hex[i]}${hex[i + 1]}`).join('-')
}

export const isKeyFingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{4}(?:-[0-9a-f]{4}){3}$/.test(value)
