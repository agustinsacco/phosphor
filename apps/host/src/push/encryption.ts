import { createCipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from 'node:crypto'

/** One aes128gcm record (RFC 8188) carries the whole message. */
export const PUSH_RECORD_SIZE = 4096
const TAG_BYTES = 16
const HEADER_BYTES = 16 + 4 + 1 + 65

export interface PushEncryptionKeys {
  /** The subscription's P-256 public key: 65 uncompressed bytes. */
  p256dh: Buffer
  /** The subscription's 16-byte authentication secret. */
  auth: Buffer
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number) =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, length))

/**
 * RFC 8291 message encryption: a fresh application-server key pair and salt per message,
 * so only the subscribed device can read it. Tests inject both to check the RFC's vector.
 */
export function encryptPushMessage(
  plaintext: Buffer,
  keys: PushEncryptionKeys,
  fresh: { ecdh?: ECDH; salt?: Buffer } = {},
): Buffer {
  if (plaintext.length + 1 + TAG_BYTES + HEADER_BYTES > PUSH_RECORD_SIZE)
    throw new Error('push message too large')
  const ecdh = fresh.ecdh ?? createECDH('prime256v1')
  if (!fresh.ecdh) ecdh.generateKeys()
  const salt = fresh.salt ?? randomBytes(16)
  const serverPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(keys.p256dh)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), keys.p256dh, serverPublic])
  const ikm = hkdf(keys.auth, secret, keyInfo, 32)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 marks the last (and only) record; no padding follows it.
  const body = Buffer.concat([
    cipher.update(plaintext),
    cipher.update(Buffer.of(2)),
    cipher.final(),
  ])
  const header = Buffer.alloc(16 + 4 + 1)
  salt.copy(header, 0)
  header.writeUInt32BE(PUSH_RECORD_SIZE, 16)
  header.writeUInt8(serverPublic.length, 20)
  return Buffer.concat([header, serverPublic, body, cipher.getAuthTag()])
}

/** True when `p256dh` is a point on P-256 that a message can be encrypted to. */
export function isUsablePushKey(p256dh: Buffer): boolean {
  try {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    ecdh.computeSecret(p256dh)
    return true
  } catch {
    return false
  }
}
