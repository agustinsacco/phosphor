import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import {
  CONTROL_LIMITS,
  HOST_HEADERS,
  formatKeyFingerprint,
  hostSigningString,
  isPublicKey,
  isUuid,
  parseTimestamp,
} from '@phosphor/shared/control-api'

export type SigningIdentity = { publicKey: string } | { hostId: string }

export function publicIdentity(key: KeyObject) {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Identity key must be Ed25519.')
  const raw = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32)
  return {
    publicKey: raw.toString('base64url'),
    keyFingerprint: formatKeyFingerprint(createHash('sha256').update(raw).digest()),
  }
}

export function freshKey(): KeyObject {
  return generateKeyPairSync('ed25519').privateKey
}

export function signRequest(input: {
  method: 'GET' | 'POST'
  path: string
  identity: SigningIdentity
  body: string
  key: KeyObject
  now: () => number
  random: (size: number) => Uint8Array
}): Record<string, string> {
  const { method, path, identity, body, key } = input
  if (
    !/^\/api\/v1\/[a-z]+(?:\/[a-z]+)*$/.test(path) ||
    Buffer.byteLength(body) > CONTROL_LIMITS.bodyBytes
  ) {
    throw new Error('Invalid signed request.')
  }
  const enrolling = 'publicKey' in identity
  const enrolled = 'hostId' in identity
  if (enrolling === enrolled) throw new Error('Invalid signing identity.')
  const id = enrolling ? identity.publicKey : identity.hostId
  if (!(enrolling ? isPublicKey(id) : isUuid(id))) throw new Error('Invalid signing identity.')
  const bytes = input.random(16)
  if (bytes.length !== 16) throw new Error('Invalid nonce source.')
  const timestamp = String(Math.floor(input.now() / 1000))
  if (parseTimestamp(timestamp) === null) throw new Error('Invalid signing clock.')
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519')
    throw new Error('Invalid signing key.')
  const nonce = Buffer.from(bytes).toString('base64url')
  const signature = sign(
    null,
    Buffer.from(
      hostSigningString({
        method,
        path,
        identity: id,
        timestamp,
        nonce,
        bodySha256: createHash('sha256').update(body).digest('hex'),
      }),
    ),
    key,
  ).toString('base64url')
  return {
    [enrolling ? HOST_HEADERS.key : HOST_HEADERS.host]: id,
    [HOST_HEADERS.timestamp]: timestamp,
    [HOST_HEADERS.nonce]: nonce,
    [HOST_HEADERS.signature]: signature,
  }
}
