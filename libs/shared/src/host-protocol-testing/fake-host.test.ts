import { generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { decodeBase64url, encodeGrant, grantUtf8, type GrantPayload } from '../host-grant'
import { helloProofMessage } from '../host-protocol'
import { createFakeHost } from './fake-host'
import { createLoopbackPair } from './loopback'
import { defineHostConformance } from './conformance'

defineHostConformance('fake Host protocol v1', (limits) => {
  const control = generateKeyPairSync('ed25519'),
    host = generateKeyPairSync('ed25519'),
    wrong = generateKeyPairSync('ed25519')
  const publicKey = host.publicKey.export({ format: 'jwk' }).x
  if (!publicKey) throw new Error('No public key')
  const raw = decodeBase64url(publicKey)
  if (!raw) throw new Error('Invalid public key')
  const claims: GrantPayload = {
    v: 1,
    iss: 'http://localhost:12345',
    kid: 'test-key',
    sub: randomUUID(),
    sid: randomUUID(),
    hostId: randomUUID(),
    epoch: 1,
    client: { id: randomUUID(), label: 'First viewer' },
    caps: ['sessions.read', 'sessions.control'],
    iat: Date.now() / 1000,
    exp: Date.now() / 1000 + 300,
    jti: randomBytes(8).toString('hex'),
  }
  const { commandDelayMs, ...hostLimits } = limits
  const driver = createFakeHost({
    expectations: {
      iss: claims.iss,
      hostId: claims.hostId,
      owner: claims.sub,
      epoch: claims.epoch,
    },
    id: randomUUID,
    epoch: () => randomBytes(8).toString('hex'),
    sign: (bytes) => sign(null, bytes, host.privateKey),
    verify: (bytes, signature, kid) =>
      kid === claims.kid && verify(null, bytes, control.publicKey, signature),
    limits: hostLimits,
    commandDelayMs,
  })
  return {
    claims,
    publicKey: raw,
    driver,
    requestId: randomUUID,
    connect() {
      const pair = createLoopbackPair({
        inboundFrameBytes: limits.inboundFrameBytes,
        outboundFrameBytes: limits.outboundFrameBytes,
      })
      driver.attach(pair.server)
      return { ...pair, socket: pair.client }
    },
    mintGrant(overrides = {}, badSignature = false) {
      return encodeGrant({ ...claims, ...overrides }, (bytes) =>
        sign(null, bytes, badSignature ? wrong.privateKey : control.privateKey),
      )
    },
    verifyProof(ready, challenge) {
      const proof = decodeBase64url(ready.proof)
      return (
        proof !== null &&
        verify(
          null,
          grantUtf8(helloProofMessage(ready.hello.hostId, ready.hello.runtimeEpoch, challenge)),
          host.publicKey,
          proof,
        )
      )
    },
  }
})
