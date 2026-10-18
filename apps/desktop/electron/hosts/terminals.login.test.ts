import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { drain, setup } from './__fixtures__/terminals'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('opens a machine-scoped sign-in terminal with no lane/fence and preserves window ownership', async () => {
  const t = await setup()
  t.viewer()
  const pending = t.bridge.signIn(1, t.hostId, 'xai')
  await drain()
  const { ptyId } = await pending
  const command = t.frames.find((f) => f.type === 'command')
  expect(command).toMatchObject({
    type: 'command',
    op: { type: 'provider.login', provider: 'xai' },
  })
  expect(command && 'laneId' in command ? command.laneId : undefined).toBeUndefined()
  expect(command && 'fence' in command ? command.fence : undefined).toBeUndefined()
  await t.attach(ptyId)
  await expect(t.bridge.route(2, 'pty:write', [ptyId, 'private-input'])?.result).rejects.toThrow()
  await t.route('pty:write', ptyId, 'private-input')
  expect(JSON.stringify(t.log.mock.calls)).not.toContain('private-input')
  t.connection.close()
})

it.each(['terminal', 'sessions.control'] as const)(
  'refuses sign-in after %s is lost in flight',
  async (cap) => {
    const t = await setup()
    t.delayReceipt()
    const pending = t.bridge.signIn(1, t.hostId, 'xai')
    const rejected = expect(pending).rejects.toThrow()
    await drain()
    t.loseCapability(cap)
    await t.reconnect()
    t.receipt()
    await drain()
    await rejected
    t.connection.close()
  },
)

it('emits one Desktop completion for an exited sign-in reset followed by its exit frame', async () => {
  const t = await setup()
  const pending = t.bridge.signIn(1, t.hostId, 'xai')
  await drain()
  const { ptyId } = await pending
  t.pauseReset()
  const attaching = t.route('pty:attach', ptyId)
  await drain()
  const sub = t.frames.find((f) => f.type === 'subscribe' && f.topic === 'terminal')
  if (sub?.type !== 'subscribe') throw new Error('Missing subscription')
  t.raw({
    type: 'terminal.reset',
    id: sub.id,
    terminalId: t.terminalId,
    epoch: '1111111111111111',
    seq: 1,
    data: '',
    inputSeq: 0,
    status: 'exited',
  })
  t.raw({
    type: 'terminal.exit',
    id: sub.id,
    terminalId: t.terminalId,
    epoch: '1111111111111111',
    seq: 2,
    exitCode: 0,
  })
  await drain()
  expect(await attaching).toEqual({ scrollback: '' })
  await vi.advanceTimersByTimeAsync(1)
  expect(t.emit.mock.calls.filter((c) => c[1] === `pty:exit:${ptyId}`)).toHaveLength(1)
  t.connection.close()
})

it('kills sign-in before attach without any reset', async () => {
  const t = await setup()
  const { ptyId } = await t.bridge.signIn(1, t.hostId, 'xai')
  await t.route('pty:kill', ptyId)
  expect(t.frames.filter((f) => f.type === 'command').at(-1)).toMatchObject({
    op: { type: 'terminal.kill' },
  })
  await t.route('pty:kill', ptyId)
  t.connection.close()
})

it('retains pending cleanup across reconnect, without a reset', async () => {
  const t = await setup()
  const { ptyId } = await t.bridge.signIn(1, t.hostId, 'xai')
  t.disconnect()
  await t.route('pty:kill', ptyId)
  await vi.advanceTimersByTimeAsync(1000)
  await drain()
  t.bridge.reconcile()
  await drain()
  expect(t.frames.filter((f) => f.type === 'command').at(-1)).toMatchObject({
    op: { type: 'terminal.kill' },
  })
  t.connection.close()
})

it('delivers a confirmed sign-in receipt after same-epoch reconnect', async () => {
  const t = await setup()
  t.delayReceipt()
  const pending = t.bridge.signIn(1, t.hostId, 'xai')
  await drain()
  await t.reconnect()
  t.receipt()
  const { ptyId } = await pending
  await t.attach(ptyId)
  expect(
    new Set(
      t.frames
        .filter((f) => f.type === 'command' && f.op.type === 'provider.login')
        .map((f) => (f.type === 'command' ? f.requestId : '')),
    ),
  ).toHaveLength(1)
  t.connection.close()
})

it('kills confirmed admission after its window was cleared', async () => {
  const t = await setup()
  t.delayReceipt()
  const pending = t.bridge.signIn(1, t.hostId, 'xai')
  const rejected = expect(pending).rejects.toThrow()
  await drain()
  t.bridge.clear(1)
  t.receipt()
  await drain()
  t.receipt()
  await rejected
  expect(t.frames.filter((f) => f.type === 'command').at(-1)).toMatchObject({
    op: { type: 'terminal.kill' },
  })
  t.connection.close()
})

it('repeated completed sign-ins dispose entries and watches idempotently', async () => {
  const t = await setup()
  for (let i = 0; i < 130; i++) {
    const { ptyId } = await t.bridge.signIn(1, t.hostId, 'xai')
    await t.attach(ptyId)
    t.interrupt()
    await drain()
    await t.route('pty:kill', ptyId)
    await t.route('pty:kill', ptyId)
    await expect(t.route('pty:attach', ptyId)).rejects.toThrow()
  }
  expect(t.frames.filter((f) => f.type === 'unsubscribe')).toHaveLength(130)
  expect(
    t.frames.filter((f) => f.type === 'command' && f.op.type === 'terminal.kill'),
  ).toHaveLength(0)
  t.connection.close()
})

it.each(['removed', 'epoch'] as const)('drops pending kills after machine %s', async (reason) => {
  const t = await setup()
  const { ptyId } = await t.bridge.signIn(1, t.hostId, 'xai')
  t.disconnect()
  await t.route('pty:kill', ptyId)
  if (reason === 'removed') t.setCurrent()
  await t.reconnect(reason === 'epoch')
  t.bridge.reconcile()
  await drain()
  expect(
    t.frames.filter((f) => f.type === 'command' && f.op.type === 'terminal.kill'),
  ).toHaveLength(0)
  t.connection.close()
})

it('unknown login receipt never creates a bridge entry or retries creation', async () => {
  const t = await setup()
  const send = vi
    .spyOn(t.connection, 'send')
    .mockResolvedValue({ requestId: randomUUID(), status: 'unknown' })
  await expect(t.bridge.signIn(1, t.hostId, 'xai')).rejects.toThrow('Sign-in not confirmed')
  t.bridge.reconcile()
  expect(send).toHaveBeenCalledOnce()
  t.connection.close()
})

it('disposes pending cleanup when Host reports the terminal gone', async () => {
  const t = await setup()
  const { ptyId } = await t.bridge.signIn(1, t.hostId, 'xai')
  const send = vi.spyOn(t.connection, 'send').mockResolvedValue({
    requestId: randomUUID(),
    status: 'unknown',
  })
  const close = vi.fn()
  vi.spyOn(t.connection, 'watchTerminal').mockImplementation((_id, listener) => {
    queueMicrotask(() => listener({ type: 'subscribe-failed', id: 'gone', code: 'unknown-lane' }))
    return { close, reset: vi.fn() }
  })
  await t.route('pty:kill', ptyId)
  await drain()
  t.bridge.reconcile()
  await t.route('pty:kill', ptyId)
  expect(send).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
  await expect(t.attach(ptyId)).rejects.toThrow()
  t.connection.close()
})

it.each(['too-many', 'bad-request', 'forbidden'] as const)(
  'retains pending cleanup after transient subscription failure %s and retries on reconnect',
  async (code) => {
    const t = await setup()
    const { ptyId } = await t.bridge.signIn(1, t.hostId, 'xai')
    const send = vi.spyOn(t.connection, 'send').mockResolvedValue({
      requestId: randomUUID(),
      status: 'unknown',
    })
    const close = vi.fn()
    vi.spyOn(t.connection, 'watchTerminal').mockImplementation((_id, listener) => {
      queueMicrotask(() => listener({ type: 'subscribe-failed', id: 'retry', code }))
      return { close, reset: vi.fn() }
    })
    await t.route('pty:kill', ptyId)
    await drain()
    expect(close).toHaveBeenCalledOnce()
    await t.reconnect()
    send.mockResolvedValue({ requestId: randomUUID(), status: 'done' })
    t.bridge.reconcile()
    await drain()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]?.[0]).toEqual({ type: 'terminal.kill', terminalId: t.terminalId })
    await t.route('pty:kill', ptyId)
    expect(send).toHaveBeenCalledTimes(2)
    t.connection.close()
  },
)

it.each(['signIn', 'create'] as const)(
  'counts concurrent %s admissions against the bridge bound and releases failed reservations',
  async (kind) => {
    const t = await setup()
    const send = vi.spyOn(t.connection, 'send').mockImplementation(async () => ({
      requestId: randomUUID(),
      status: 'done',
      data: { terminalId: randomUUID() },
    }))
    for (let i = 0; i < 1023; i++) await t.bridge.signIn(1, t.hostId, 'xai')
    let fail!: (error: Error) => void
    send.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
    const pending = kind === 'signIn' ? t.bridge.signIn(1, t.hostId, 'xai') : t.create()
    const rejected = expect(pending).rejects.toThrow('Admission failed')
    await expect(t.bridge.signIn(1, t.hostId, 'xai')).rejects.toThrow('Not available')
    await expect(t.create()).rejects.toThrow('Terminal limit reached')
    expect(send).toHaveBeenCalledTimes(1024)
    fail(new Error('Admission failed'))
    await rejected
    const { ptyId } = await t.bridge.signIn(1, t.hostId, 'xai')
    await expect(t.bridge.signIn(1, t.hostId, 'xai')).rejects.toThrow('Not available')
    await t.route('pty:kill', ptyId)
    await t.bridge.signIn(1, t.hostId, 'xai')
    expect(send).toHaveBeenCalledTimes(1027)
    t.connection.close()
  },
)
