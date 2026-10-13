import { generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  decodeBase64url,
  encodeBase64url,
  encodeGrant,
  grantUtf8,
  type GrantPayload,
} from '../host-grant'
import { helloProofMessage, parseHostFrame, type HostFrame } from '../host-protocol'
import { createFakeHost } from './fake-host'
import { createLoopbackPair } from './loopback'
import { defineHostConformance, type HostConformanceFactory } from './conformance'

const factory: HostConformanceFactory = (limits) => {
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
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
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
    signHelloProof(hostId, runtimeEpoch, challenge) {
      return encodeBase64url(
        sign(null, grantUtf8(helloProofMessage(hostId, runtimeEpoch, challenge)), host.privateKey),
      )
    },
    verifyProof(ready, challenge) {
      const proof = decodeBase64url(ready.proof)
      return (
        ready.hello.hostId === claims.hostId &&
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
}

defineHostConformance('fake Host protocol v1', factory)

it('rejects lowered limits that are not positive safe integers or exceed the contract', () => {
  for (const value of [0, -1, 0.5, NaN, Infinity, 65])
    expect(() => factory({ subscriptionsPerConnection: value })).toThrow('Invalid limit')
})
it('bounds stored UI keys while allowing replacement and clearing at capacity', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  const h = factory({ uiStatusKeys: 1, uiWidgetKeys: 1 })
  try {
    const c = h.connect(),
      frames: HostFrame[] = []
    c.socket.onMessage((text) => {
      const parsed = parseHostFrame(text)
      if (!parsed.ok) throw new Error('Invalid Host frame')
      frames.push(parsed.value)
    })
    c.socket.send(JSON.stringify({ type: 'auth', grant: h.mintGrant(), challenge: 'a'.repeat(64) }))
    await vi.advanceTimersByTimeAsync(0)
    c.socket.send(
      JSON.stringify({
        type: 'command',
        requestId: h.requestId(),
        op: { type: 'lane.create', repositoryId: '0123456789abcdef', worktree: null },
      }),
    )
    await vi.advanceTimersByTimeAsync(0)
    const frame = frames.find((frame) => frame.type === 'receipt')
    if (
      !frame ||
      frame.type !== 'receipt' ||
      frame.receipt.status !== 'done' ||
      !frame.receipt.laneId
    )
      throw new Error('No lane')
    const laneId = frame.receipt.laneId
    h.driver.emitUi(laneId, {
      type: 'extension_ui_request',
      id: 'ui',
      method: 'setStatus',
      statusKey: 'one',
      statusText: 'first',
    })
    h.driver.emitUi(laneId, {
      type: 'extension_ui_request',
      id: 'ui',
      method: 'setStatus',
      statusKey: 'one',
      statusText: 'replacement',
    })
    expect(() =>
      h.driver.emitUi(laneId, {
        type: 'extension_ui_request',
        id: 'ui',
        method: 'setStatus',
        statusKey: 'two',
        statusText: 'second',
      }),
    ).toThrow('UI keys full')
    h.driver.emitUi(laneId, {
      type: 'extension_ui_request',
      id: 'ui',
      method: 'setStatus',
      statusKey: 'one',
      statusText: undefined,
    })
    h.driver.emitUi(laneId, {
      type: 'extension_ui_request',
      id: 'ui',
      method: 'setStatus',
      statusKey: 'two',
      statusText: 'second',
    })
    h.driver.emitUi(laneId, {
      type: 'extension_ui_request',
      id: 'ui',
      method: 'setWidget',
      widgetKey: 'one',
      widgetLines: ['first'],
    })
    expect(() =>
      h.driver.emitUi(laneId, {
        type: 'extension_ui_request',
        id: 'ui',
        method: 'setWidget',
        widgetKey: 'two',
        widgetLines: ['second'],
      }),
    ).toThrow('UI keys full')
  } finally {
    h.driver.stop()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
  }
})
