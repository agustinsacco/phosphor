import { expect, it, vi } from 'vitest'
import { BRAIN_SURFACE } from '@phosphor/shared/host-brain'
import { HOST_LIMITS, type FrameSocket, type HostFrame } from '@phosphor/shared/host-protocol'
import { createHostConnection } from './connection'
import { browserCrypto } from './crypto'

const hostId = '11111111-1111-4111-8111-111111111111'
const endpoint = 'https://fixture.tail.ts.net:47615'
type Ports = Parameters<typeof createHostConnection>[0]
type SetupOptions = {
  ports?: Partial<
    Pick<Ports, 'lanes' | 'local' | 'changed' | 'onRoutinesChanged' | 'onAttention' | 'traffic'>
  >
  frame?: Record<string, unknown>
}
async function setup(sendReady = true, options: SetupOptions = {}) {
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
    ...options.ports,
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
    ...options.frame,
  })
  if (sendReady) message(ready)
  return {
    connection,
    sent,
    message,
    ready,
    grant,
    clearGrant,
    socket,
    closeTransport: () => socket.close(4400, 'Bad frame'),
    closeEvent: (code: number) => {
      open = false
      closed(code, '')
    },
    resolve: (valid: boolean) => resolve(valid),
  }
}
it('refuses commands and queries and withholds subscriptions before async proof', async () => {
  // A granting Host: one that grants nothing withholds lane watches (connection.wake.test.ts).
  const caps = ['sessions.read']
  const t = await setup(true, {
    frame: {
      capabilities: caps,
      hello: {
        hostId,
        hostVersion: '1.0.0',
        protocolVersion: 1,
        runtimeEpoch: 'a'.repeat(16),
        capabilities: caps,
      },
    },
  })
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

it('closes an established connection on an unknown Host frame type', async () => {
  const t = await setup()
  try {
    t.resolve(true)
    await Promise.resolve()
    expect(t.connection.snapshot().state).toBe('ready')
    const close = vi.spyOn(t.socket, 'close')
    t.message(JSON.stringify({ type: 'future-frame' }))
    expect(close).toHaveBeenCalledWith(4400, 'Bad frame')
  } finally {
    t.connection.close()
  }
})
it('skips the automatic lanes subscription for a connection that only runs ops', async () => {
  const t = await setup(true, { ports: { lanes: false }, frame: { ops: true } })
  try {
    t.resolve(true)
    await Promise.resolve()
    expect(t.connection.snapshot()).toMatchObject({ state: 'ready', ops: true })
    expect(t.sent.map((f) => f.type)).toEqual(['auth'])
  } finally {
    t.connection.close()
  }
})
it.each([
  [undefined, undefined],
  [true, true],
] as const)('projects ownerLocal only on a local connection (local %s)', async (local, owner) => {
  const t = await setup(true, { ports: { local }, frame: { ownerLocal: true } })
  try {
    t.resolve(true)
    await Promise.resolve()
    expect(t.connection.snapshot().ownerLocal).toBe(owner)
  } finally {
    t.connection.close()
  }
})

it('keeps the connection open when renewal fails before grant expiry', async () => {
  vi.useFakeTimers()
  const t = await setup()
  try {
    t.resolve(true)
    await Promise.resolve()
    t.grant.mockRejectedValue(new Error('offline'))
    for (let elapsed = 0; elapsed < (300 - HOST_LIMITS.renewBeforeSec) * 1000;) {
      const step = Math.min(
        HOST_LIMITS.pingIntervalMs,
        (300 - HOST_LIMITS.renewBeforeSec) * 1000 - elapsed,
      )
      await vi.advanceTimersByTimeAsync(step)
      t.message(JSON.stringify({ type: 'pong', at: Date.now() }))
      elapsed += step
    }
    expect(t.grant).toHaveBeenCalledTimes(2)
    expect(t.socket.isOpen()).toBe(true)
    expect(t.connection.snapshot().state).toBe('ready')
  } finally {
    t.connection.close()
    vi.useRealTimers()
  }
})

it('accepts only the directory subscription and keeps its cursor across refreshes', async () => {
  const changed = vi.fn()
  const onRoutinesChanged = vi.fn()
  const onAttention = vi.fn()
  const t = await setup(true, { ports: { changed, onRoutinesChanged, onAttention } })
  const epoch = 'a'.repeat(16)
  const cursor = (seq: number) => ({ epoch, seq })
  const receive = (frame: HostFrame) => t.message(JSON.stringify(frame))
  const directory = (seq: number, id = 'lanes', e = epoch) =>
    receive({ type: 'lanes', id, cursor: { epoch: e, seq }, lanes: [], repositories: [] })
  try {
    t.resolve(true)
    await Promise.resolve()
    directory(99, 'unrelated')
    expect(t.connection.snapshot().cursor).toBeUndefined()
    directory(1)
    const gap = {
      type: 'lanes-delta',
      id: 'lanes',
      cursor: cursor(3),
      upsert: [],
      remove: [],
    } as const
    receive(gap)
    expect(t.sent.at(-1)).toMatchObject({ type: 'subscribe', topic: 'lanes', id: 'lanes' })
    expect(t.connection.snapshot().cursor).toEqual(cursor(1))

    changed.mockClear()
    receive({ type: 'routines-changed', id: 'lanes', cursor: cursor(2) })
    expect(onRoutinesChanged).toHaveBeenCalledTimes(1)
    expect(changed).not.toHaveBeenCalled()
    expect(t.connection.snapshot().cursor).toEqual(cursor(2))
    receive(gap)
    const event = {
      id: `${hostId}:1`,
      laneId: hostId,
      kind: 'finished',
      title: 'Fixture',
      at: new Date().toISOString(),
      attention: 1,
    } as const
    receive({ type: 'attention', id: 'lanes', cursor: cursor(4), event })
    receive({ type: 'attention', id: 'lanes', cursor: cursor(5), event })
    expect(onAttention).toHaveBeenCalledExactlyOnceWith(event)
    directory(3)
    expect(t.connection.snapshot().cursor).toEqual(cursor(5))
    expect(t.connection.attention().map((f) => f.event)).toEqual([event])
    directory(0, 'lanes', 'c'.repeat(16))
    expect(t.connection.attention()).toEqual([])
  } finally {
    t.connection.close()
  }
})

it('settles private Brain receipts and results without reporting their frames as traffic', async () => {
  const traffic = vi.fn<NonNullable<Ports['traffic']>>()
  const t = await setup(true, { ports: { traffic } })
  const receive = (frame: HostFrame) => t.message(JSON.stringify(frame))
  try {
    t.resolve(true)
    await Promise.resolve()
    traffic.mockClear()
    const take = t.connection.send({ type: 'control.take' }, hostId)
    const publicCommand = expect.objectContaining({ type: 'command', op: { type: 'control.take' } })
    expect(t.sent.at(-1)).toEqual(publicCommand)
    const args = { method: 'brain:status', args: [] }
    const write = t.connection.send({ type: 'ops.run', op: BRAIN_SURFACE, args })
    const read = t.connection.call('ops.run', { op: BRAIN_SURFACE, args })
    const command = (index: number) => (t.sent.at(index) as { requestId?: string }).requestId!
    const done = (requestId: string, data: string) => ({ requestId, status: 'done', data }) as const
    const receipt = done(command(-2), 'synthetic private receipt')
    const publicReceipt = done(command(-3), 'synthetic public receipt')
    const result = {
      type: 'result',
      id: (t.sent.at(-1) as { id?: string }).id!,
      ok: true,
      data: 'synthetic private result',
    } as const
    receive({ type: 'receipt', receipt })
    receive(result)
    receive({ type: 'receipt', receipt: publicReceipt })
    receive({ type: 'receipt', receipt: done(hostId, 'synthetic untracked receipt') })
    await expect(write).resolves.toEqual(receipt)
    await expect(read).resolves.toEqual(result)
    await expect(take).resolves.toEqual(publicReceipt)
    expect(traffic.mock.calls.map(([direction, frame]) => [direction, frame])).toEqual([
      ['out', publicCommand],
      ['in', { type: 'receipt', receipt: publicReceipt }],
    ])
  } finally {
    t.connection.close()
  }
})
