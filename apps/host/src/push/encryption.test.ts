import { createECDH } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encryptPushMessage, isUsablePushKey } from './encryption'
import { decryptPushMessage as decrypt, pushDevice } from './__fixtures__/device'

const b64 = (value: string) => Buffer.from(value, 'base64url')

/** RFC 8291 Appendix A. */
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  serverPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  serverPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  agentPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  agentPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

function rfcServer() {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(b64(RFC.serverPrivate))
  return ecdh
}

describe('RFC 8291 message encryption', () => {
  it('reproduces the RFC 8291 Appendix A test vector byte for byte', () => {
    const server = rfcServer()
    expect(server.getPublicKey().toString('base64url')).toBe(RFC.serverPublic)
    const message = encryptPushMessage(
      b64(RFC.plaintext),
      { p256dh: b64(RFC.agentPublic), auth: b64(RFC.auth) },
      { ecdh: server, salt: b64(RFC.salt) },
    )
    expect(message.toString('base64url')).toBe(RFC.message)
  })
  it('uses a fresh key pair and salt per message, readable only with the device keys', () => {
    const device = pushDevice()
    const agent = device.ecdh
    const keys = { p256dh: agent.getPublicKey(), auth: device.auth }
    const one = encryptPushMessage(Buffer.from('{"v":1}'), keys)
    const two = encryptPushMessage(Buffer.from('{"v":1}'), keys)
    expect(one.subarray(0, 16)).not.toEqual(two.subarray(0, 16))
    expect(one.subarray(21, 86)).not.toEqual(two.subarray(21, 86))
    expect(one.readUInt32BE(16)).toBe(4096)
    expect(decrypt(one, agent, keys.auth)).toBe('{"v":1}')
    expect(() => decrypt(one, agent, Buffer.alloc(16, 8))).toThrow()
    expect(() => decrypt(one, pushDevice().ecdh, keys.auth)).toThrow()
  })
  it('refuses a message larger than one record', () => {
    const agent = createECDH('prime256v1')
    agent.generateKeys()
    const keys = { p256dh: agent.getPublicKey(), auth: Buffer.alloc(16) }
    expect(() => encryptPushMessage(Buffer.alloc(3993), keys)).not.toThrow()
    expect(() => encryptPushMessage(Buffer.alloc(3994), keys)).toThrow('too large')
  })
  it('recognises a subscription key that is not a point on P-256', () => {
    expect(isUsablePushKey(b64(RFC.agentPublic))).toBe(true)
    const off = Buffer.from(b64(RFC.agentPublic))
    off.writeUInt8(off.readUInt8(64) ^ 1, 64)
    expect(isUsablePushKey(off)).toBe(false)
    expect(isUsablePushKey(Buffer.alloc(65, 4))).toBe(false)
  })
})
