import { expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { createHandshake } from './handshake'
import { browserCrypto, UnsupportedIdentityCrypto } from './crypto'

const ready = JSON.stringify({
  type: 'ready',
  protocolVersion: 1,
  hello: {
    hostId: '11111111-1111-4111-8111-111111111111',
    hostVersion: '1.0.0',
    protocolVersion: 1,
    runtimeEpoch: 'a'.repeat(16),
    capabilities: [],
  },
  proof: 'A'.repeat(86),
  connectionId: 'b'.repeat(16),
  grantExpiresAt: new Date(300000).toISOString(),
  client: { id: '22222222-2222-4222-8222-222222222222', label: 'Test' },
  capabilities: [],
})
const pong = JSON.stringify({ type: 'pong', at: 1 })
function setup() {
  let resolve!: (valid: boolean) => void
  let reject!: (error: Error) => void
  let current = true
  const receive = vi.fn(),
    refuse = vi.fn()
  const verify = vi.fn(
    () =>
      new Promise<boolean>((yes, no) => {
        resolve = yes
        reject = no
      }),
  )
  const gate = createHandshake({
    hostId: '11111111-1111-4111-8111-111111111111',
    key: 'key',
    challenge: 'fresh',
    identity: { ...browserCrypto, verify },
    current: () => current,
    receive,
    refuse,
  })
  return {
    gate,
    receive,
    refuse,
    verify,
    resolve: (valid: boolean) => resolve(valid),
    reject: (error: Error) => reject(error),
    stale: () => {
      current = false
    },
  }
}
it('holds ordered frames until proof succeeds exactly once', async () => {
  const t = setup()
  t.gate.receive(ready)
  t.gate.receive(pong)
  expect(t.receive).not.toHaveBeenCalled()
  t.resolve(true)
  await Promise.resolve()
  expect(t.receive.mock.calls.map(([text]) => text)).toEqual([ready, pong])
  expect(t.verify).toHaveBeenCalledTimes(1)
})
it.each(['stale', 'false', 'duplicate', 'overflow', 'unsupported', 'malformed'])(
  'never releases frames after %s verification',
  async (failure) => {
    const t = setup()
    t.gate.receive(ready)
    t.gate.receive(pong)
    if (failure === 'stale') t.stale()
    if (failure === 'duplicate') t.gate.receive(ready)
    if (failure === 'malformed') t.gate.receive('{}')
    if (failure === 'overflow')
      for (let i = 0; i < HOST_LIMITS.pendingEvents; i++) t.gate.receive(pong)
    if (failure === 'unsupported') t.reject(new UnsupportedIdentityCrypto())
    else t.resolve(failure !== 'false')
    await Promise.resolve()
    expect(t.receive).not.toHaveBeenCalled()
    if (failure !== 'stale') expect(t.refuse).toHaveBeenCalledWith(failure === 'unsupported')
  },
)
