import { expect, it, vi } from 'vitest'
import { HOST_LIMITS, type FrameSocket } from '@phosphor/shared/host-protocol'
import { createHostConnection } from './connection'
import { browserCrypto } from './crypto'

const hostId = '11111111-1111-4111-8111-111111111111'
const endpoint = 'https://fixture.tail.ts.net:47615'
async function setup(sendReady = true) {
  let resolve!: (valid: boolean) => void
  let message!: (text: string) => void
  let closed!: (code: number, reason: string) => void
  const sent: { type: string }[] = []
  let open = true
  const socket: FrameSocket = {
    send: (text) => {
      sent.push(JSON.parse(text))
    },
    close: () => {
      open = false
    },
    onMessage: (cb) => {
      message = cb
    },
    onClose: (cb) => {
      closed = cb
    },
    isOpen: () => open,
    bufferedBytes: () => 0,
  }
  const grant = vi.fn(async () => ({
    grant: 'fixture',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    host: { id: hostId, endpoint, publicKey: 'fixture' },
  }))
  const clearGrant = vi.fn()
  const connection = createHostConnection({
    hostId,
    endpoint,
    identity: {
      ...browserCrypto,
      verify: () =>
        new Promise<boolean>((r) => {
          resolve = r
        }),
    },
    socket: async () => socket,
    grant,
    clearGrant,
    random: () => 1,
    changed: () => {},
  })
  for (let i = 0; i < 5; i++) await Promise.resolve()
  const ready = JSON.stringify({
    type: 'ready',
    protocolVersion: 1,
    hello: {
      hostId,
      hostVersion: '1.0.0',
      protocolVersion: 1,
      runtimeEpoch: 'a'.repeat(16),
      capabilities: [],
    },
    proof: 'A'.repeat(86),
    connectionId: 'b'.repeat(16),
    grantExpiresAt: new Date(Date.now() + 300000).toISOString(),
    client: { id: hostId, label: 'Test' },
    capabilities: [],
  })
  if (sendReady) message(ready)
  return {
    connection,
    sent,
    message,
    ready,
    grant,
    clearGrant,
    closeTransport: () => socket.close(4400, 'Bad frame'),
    closeEvent: (code: number) => {
      open = false
      closed(code, '')
    },
    resolve: (valid: boolean) => resolve(valid),
  }
}
it('refuses commands and queries and withholds subscriptions before async proof', async () => {
  const t = await setup()
  try {
    t.connection.watchLane(hostId, () => {})
    expect(await t.connection.send({ type: 'abort' }, hostId)).toMatchObject({ status: 'not-sent' })
    expect(await t.connection.call('lane.state')).toMatchObject({ ok: false })
    expect(t.connection.snapshot().state).toBe('connecting')
    expect(t.sent.map((f) => f.type)).toEqual(['auth'])
    t.resolve(true)
    await Promise.resolve()
    expect(t.connection.snapshot().state).toBe('ready')
    expect(t.sent.map((f) => f.type)).toEqual(['auth', 'subscribe', 'subscribe'])
  } finally {
    t.connection.close()
  }
})
it.each([true, false])('late proof %s cannot resurrect signed-out state', async (valid) => {
  const t = await setup()
  t.connection.close()
  t.resolve(valid)
  await Promise.resolve()
  expect(t.connection.snapshot().state).toBe('signed-out')
  expect(t.sent.map((f) => f.type)).toEqual(['auth'])
})
it.each([4401, 4403, 4429])(
  'error then close %i preserves authentication recovery',
  async (code) => {
    vi.useFakeTimers()
    const t = await setup(false)
    try {
      t.message(JSON.stringify({ type: 'error', code, message: String(code) }))
      expect(t.connection.snapshot().state).toBe('connecting')
      // No proof or application frame after a refusal may open the barrier.
      t.message(t.ready)
      expect(t.sent.map((f) => f.type)).toEqual(['auth'])
      t.closeEvent(code)
      expect(t.connection.snapshot()).toMatchObject({
        state: 'reconnecting',
        lastError: code === 4403 ? 'forbidden' : 'disconnected',
      })
      expect(t.clearGrant).toHaveBeenCalledTimes(code === 4401 ? 1 : 0)
      const retryDelay = code === 4429 ? 30000 : 1000
      await vi.advanceTimersByTimeAsync(retryDelay - 1)
      expect(t.grant).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(t.grant).toHaveBeenCalledTimes(code === 4403 ? 1 : 2)
    } finally {
      t.connection.close()
      vi.useRealTimers()
    }
  },
)
it.each(['deadline', 'transport'])(
  'proof cannot publish ready after %s closure starts',
  async (cause) => {
    vi.useFakeTimers()
    const t = await setup()
    try {
      t.message(JSON.stringify({ type: 'pong', at: 1 }))
      if (cause === 'deadline') await vi.advanceTimersByTimeAsync(HOST_LIMITS.authTimeoutMs)
      else t.closeTransport()
      // isOpen is false, but the asynchronous close event has not arrived yet.
      t.resolve(true)
      await Promise.resolve()
      expect(t.connection.snapshot().state).toBe('connecting')
      expect(t.sent.map((f) => f.type)).toEqual(['auth'])
      t.closeEvent(4401)
      expect(t.connection.snapshot().state).toBe('reconnecting')
    } finally {
      t.connection.close()
      vi.useRealTimers()
    }
  },
)
it('failed asynchronous proof closes the connection without subscriptions', async () => {
  const t = await setup()
  t.resolve(false)
  await Promise.resolve()
  expect(t.connection.snapshot().state).toBe('wrong-machine')
  expect(t.sent.map((f) => f.type)).toEqual(['auth'])
})
