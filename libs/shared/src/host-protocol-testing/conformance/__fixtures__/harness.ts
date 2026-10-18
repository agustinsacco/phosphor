import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { encodeBase64url, encodeGrant, grantUtf8, type GrantPayload } from '../../../host-grant'
import { helloProofMessage } from '../../../host-protocol'
import type { ConformanceOptions, HostConformanceHarness } from '../../conformance'
import { createFakeHost } from '../../fake-host'
import { createLoopbackPair } from '../../loopback'

// Test-only conformance harness over the public fake Host. Signing is injected and
// deterministic: keyed HMAC-SHA-512 stands in for the control plane's and the Host's
// Ed25519 keys, so a proof still binds the Host id, runtime epoch and challenge.

const keyed = (key: string) => (bytes: Uint8Array) =>
  new Uint8Array(createHmac('sha512', key).update(bytes).digest())
const signGrant = keyed('control plane')
const forgeGrant = keyed('another signer')
const signHello = keyed('enrolled host')

export const REPOSITORY = { id: '0123456789abcdef', name: 'Repository', path: '/test/repository' }

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

/** A healthy harness; family tests inject their own defects around it. */
export function createConformanceHarness(limits: Partial<ConformanceOptions>) {
  const iat = Math.floor(Date.now() / 1000)
  const claims: GrantPayload = {
    v: 1,
    iss: 'https://control.test',
    kid: 'test-key',
    sub: randomUUID(),
    sid: randomUUID(),
    hostId: randomUUID(),
    epoch: 1,
    client: { id: randomUUID(), label: 'First viewer' },
    caps: ['sessions.read', 'sessions.control'],
    iat,
    exp: iat + 300,
    jti: randomBytes(8).toString('hex'),
  }
  const { commandDelayMs, ...hostLimits } = limits
  const driver = createFakeHost({
    expectations: { iss: claims.iss, hostId: claims.hostId, owner: claims.sub, epoch: 1 },
    id: randomUUID,
    epoch: () => randomBytes(8).toString('hex'),
    sign: signHello,
    verify: (bytes, signature, kid) => kid === claims.kid && sameBytes(signature, signGrant(bytes)),
    repositories: [REPOSITORY],
    limits: hostLimits,
    commandDelayMs,
  })
  const signHelloProof = (hostId: string, runtimeEpoch: string, challenge: string) =>
    encodeBase64url(signHello(grantUtf8(helloProofMessage(hostId, runtimeEpoch, challenge))))
  return {
    claims,
    repositoryId: REPOSITORY.id,
    publicKey: new Uint8Array(createHash('sha256').update('enrolled host').digest()),
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
    mintGrant: (overrides: Partial<GrantPayload> = {}, badSignature = false) =>
      encodeGrant({ ...claims, ...overrides }, badSignature ? forgeGrant : signGrant),
    signHelloProof,
    verifyProof: (ready, challenge) =>
      ready.hello.hostId === claims.hostId &&
      ready.proof === signHelloProof(ready.hello.hostId, ready.hello.runtimeEpoch, challenge),
  } satisfies HostConformanceHarness
}
