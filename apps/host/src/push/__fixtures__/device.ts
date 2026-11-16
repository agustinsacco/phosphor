import { createDecipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from 'node:crypto'

/** A browser's side of a push subscription: its key pair and secret. */
export function pushDevice() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    ecdh,
    auth,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  }
}

/** RFC 8291 decryption, as the device's browser does it. Throws on a wrong key or secret. */
export function decryptPushMessage(message: Buffer, agent: ECDH, auth: Buffer): string {
  const salt = message.subarray(0, 16)
  const idlen = message.readUInt8(20)
  const server = message.subarray(21, 21 + idlen)
  const secret = agent.computeSecret(server)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), agent.getPublicKey(), server])
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32))
  const key = (label: string, length: number) =>
    Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(`Content-Encoding: ${label}\0`), length))
  const body = message.subarray(21 + idlen)
  const decipher = createDecipheriv('aes-128-gcm', key('aes128gcm', 16), key('nonce', 12))
  decipher.setAuthTag(body.subarray(body.length - 16))
  const record = Buffer.concat([
    decipher.update(body.subarray(0, body.length - 16)),
    decipher.final(),
  ])
  if (record.at(-1) !== 2) throw new Error('not a last record')
  return record.subarray(0, -1).toString('utf8')
}
