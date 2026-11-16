import { rename } from 'node:fs/promises'
import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { DEFAULT_CONTROL_URL } from '@phosphor/shared/control-api'
import { isMissing, readIdentityFile, writeIdentityFileAtomic } from '../control/identity-files'
import type { IdentityPorts } from '../control/identity-types'

/** Beside the Host's identity key, owner-only like it. Never logged. */
export const VAPID_KEY_FILE = 'web-push-key.pem'
/** RFC 8292 allows at most 24 hours; a token is reused until an hour before it expires. */
const TOKEN_SECONDS = 12 * 3600
const RENEW_SECONDS = 3600

export interface VapidKey {
  privateKey: KeyObject
  /** The uncompressed P-256 public key as unpadded base64url: the `applicationServerKey`. */
  publicKey: string
}

function vapidKey(privateKey: KeyObject): VapidKey {
  const jwk = privateKey.export({ format: 'jwk' })
  if (privateKey.asymmetricKeyType !== 'ec' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y)
    throw new Error('not a P-256 key')
  const point = Buffer.concat([
    Buffer.of(4),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ])
  return { privateKey, publicKey: point.toString('base64url') }
}

/**
 * The Host's VAPID key pair, created once. A missing file is created; an unsafe or
 * unreadable one is refused, never replaced, so the Host then runs without Web Push.
 */
export async function loadVapidKey(
  directory: string,
  uid: number | undefined,
  ports: IdentityPorts = { rename },
): Promise<VapidKey> {
  try {
    return vapidKey(createPrivateKey(await readIdentityFile(directory, uid, VAPID_KEY_FILE)))
  } catch (error) {
    if (!isMissing(error)) throw new Error('Web Push key unavailable', { cause: error })
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  await writeIdentityFileAtomic({ directory, uid, ports }, VAPID_KEY_FILE, pem)
  return vapidKey(privateKey)
}

const json = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** RFC 8292 `Authorization` headers, one ES256 token per push service origin. */
export function createVapidSigner(key: VapidKey, subject: string, now: () => number) {
  // A contact for the push service: the Host's Control origin, never an account's email.
  const sub = subject.startsWith('https://') ? subject : DEFAULT_CONTROL_URL
  const tokens = new Map<string, { header: string; exp: number }>()
  return (endpoint: string): string => {
    const aud = new URL(endpoint).origin
    const seconds = Math.floor(now() / 1000)
    const cached = tokens.get(aud)
    if (cached && cached.exp - RENEW_SECONDS > seconds) return cached.header
    const exp = seconds + TOKEN_SECONDS
    const input = `${json({ typ: 'JWT', alg: 'ES256' })}.${json({ aud, exp, sub })}`
    const signature = sign('sha256', Buffer.from(input), {
      key: key.privateKey,
      dsaEncoding: 'ieee-p1363',
    })
    const header = `vapid t=${input}.${signature.toString('base64url')}, k=${key.publicKey}`
    // Push services are few; the map holds one token per allowlisted origin.
    if (tokens.size >= 16) tokens.clear()
    tokens.set(aud, { header, exp })
    return header
  }
}
