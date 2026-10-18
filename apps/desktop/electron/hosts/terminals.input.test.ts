import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { drain, setup } from './__fixtures__/terminals'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('creates with fence and opaque identity, attaches reset scrollback and splits UTF-8 input with acknowledged seq', async () => {
  const t = await setup(),
    id = await t.create()
  expect(id).not.toContain(t.terminalId)
  expect(t.frames.find((f) => f.type === 'command')).toMatchObject({
    fence: 7,
    op: { type: 'terminal.create' },
  })
  expect(await t.attach(id)).toEqual({ scrollback: 'prompt' })
  const writing = t.route('pty:write', id, '😀'.repeat(1025))
  await drain()
  await writing
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toMatchObject([
    { seq: 1, data: '😀'.repeat(1024) },
    { seq: 2, data: '😀' },
  ])
  t.connection.close()
})

it('uncertain input is never resent and reconnect resumes reset inputSeq', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  const first = t.route('pty:write', id, 'first')
  await drain()
  await first
  t.noAck()
  const uncertain = t.route('pty:write', id, 'uncertain')
  await drain()
  await t.reconnect()
  await uncertain
  await t.attach(id)
  const next = t.route('pty:write', id, 'next')
  await drain()
  await vi.advanceTimersByTimeAsync(5000)
  await next
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toMatchObject([
    { seq: 1, data: 'first' },
    { seq: 2, data: 'uncertain' },
    { seq: 2, data: 'next' },
  ])
  expect(
    t.frames.filter((f) => f.type === 'terminal.input' && f.data === 'uncertain'),
  ).toHaveLength(1)
  t.connection.close()
})

it('reconnect suspends all mutations until reset and discards the rest of an uncertain split write', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  t.pauseReset()
  const writing = t.route('pty:write', id, 'x'.repeat(5000))
  await drain()
  await t.reconnect()
  await writing
  for (const channel of ['pty:write', 'pty:resize'] as const)
    await expect(t.route(channel, id, channel === 'pty:write' ? 'input' : 80, 24)).rejects.toThrow(
      'Read-only',
    )
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toHaveLength(1)
  t.reset()
  await drain()
  const resize = t.route('pty:resize', id, 90, 25)
  await drain()
  await resize
  expect(t.frames.filter((f) => f.type === 'command').at(-1)).toMatchObject({
    op: { type: 'terminal.resize' },
  })
  t.connection.close()
})

it('stale handle after input ack drops unsent chunks and later stream output', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  const writing = t.route('pty:write', id, 'x'.repeat(5000))
  t.setCurrent()
  await drain()
  await writing
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toHaveLength(1)
  t.output(1, 'private')
  await drain()
  expect(t.emit).not.toHaveBeenCalled()
  t.connection.close()
})

it('fresh reset during an input await is not overwritten by its acknowledgement', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  const writing = t.route('pty:write', id, 'x'.repeat(5000))
  t.reset()
  await drain()
  await writing
  const next = t.route('pty:write', id, 'next')
  await drain()
  await next
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toMatchObject([
    { seq: 1, data: 'x'.repeat(4096) },
    { seq: 2, data: 'next' },
  ])
  t.connection.close()
})

it('unacked timeout drops remaining input and logs only a fixed event', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  const writing = t.route('pty:write', id, 'private'.repeat(800))
  await drain()
  await vi.advanceTimersByTimeAsync(5000)
  await writing
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toHaveLength(1)
  expect(t.inputDropped.mock.calls).toEqual([[]])
  t.receipt() // A duplicate receipt has no pending operation to classify.
  await drain()
  expect(t.log.mock.calls.some((c) => c[1] === 'receipt')).toBe(false)
  expect(JSON.stringify(t.log.mock.calls)).not.toContain(t.terminalId)
  expect(JSON.stringify(t.log.mock.calls)).not.toContain('private')
  t.connection.close()
})

it('queues ordinary keystrokes in order until the delayed acknowledgement', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  const first = t.route('pty:write', id, 'a')
  const second = t.route('pty:write', id, 'b')
  await drain()
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toMatchObject([{ seq: 1, data: 'a' }])
  t.raw({ type: 'terminal.ack', terminalId: t.terminalId, seq: 1, accepted: true })
  await drain()
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toMatchObject([
    { seq: 1, data: 'a' },
    { seq: 2, data: 'b' },
  ])
  t.raw({ type: 'terminal.ack', terminalId: t.terminalId, seq: 2, accepted: true })
  await drain()
  await Promise.all([first, second])
  t.connection.close()
})

it.each(['timeout', 'reset', 'control', 'rejection', 'disposal', 'generation'] as const)(
  'drops queued input after %s without sending it',
  async (reason) => {
    const t = await setup(),
      id = await t.create()
    await t.attach(id)
    t.noAck()
    const first = t.route('pty:write', id, 'a')
    const second = t.route('pty:write', id, 'private')
    const rejected = expect(second).rejects.toThrow('Terminal input dropped.')
    await drain()
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(5000)
    else {
      if (reason === 'reset') {
        t.reset()
        await drain()
        expect(t.inputDropped).toHaveBeenCalledTimes(1)
      }
      if (reason === 'control') {
        t.viewer()
        await drain()
        t.bridge.reconcile()
        expect(t.inputDropped).toHaveBeenCalledTimes(1)
      }
      if (reason === 'disposal') {
        t.bridge.clear()
        expect(t.inputDropped).toHaveBeenCalledTimes(1)
      }
      if (reason === 'generation') await t.reconnect()
      t.raw({
        type: 'terminal.ack',
        terminalId: t.terminalId,
        seq: 1,
        accepted: reason !== 'rejection',
      })
    }
    await drain()
    await first
    await rejected
    expect(t.frames.filter((f) => f.type === 'terminal.input')).toHaveLength(1)
    expect(t.inputDropped.mock.calls).toEqual([[]])
    t.connection.close()
  },
)

it('a dropped active queued write cannot resume if control returns before its ack', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  const first = t.route('pty:write', id, 'a')
  const second = t.route('pty:write', id, 'x'.repeat(5000))
  const rejected = expect(second).rejects.toThrow('Terminal input dropped.')
  await drain()
  t.raw({ type: 'terminal.ack', terminalId: t.terminalId, seq: 1, accepted: true })
  await drain()
  t.viewer()
  await drain()
  t.bridge.reconcile()
  await rejected
  t.controller()
  await drain()
  t.raw({ type: 'terminal.ack', terminalId: t.terminalId, seq: 2, accepted: true })
  await drain()
  await first
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toHaveLength(2)
  const next = t.route('pty:write', id, 'next')
  await drain()
  expect(t.frames.filter((f) => f.type === 'terminal.input').at(-1)).toMatchObject({
    seq: 3,
    data: 'next',
  })
  t.raw({ type: 'terminal.ack', terminalId: t.terminalId, seq: 3, accepted: true })
  await drain()
  await next
  expect(t.inputDropped.mock.calls).toEqual([[]])
  t.connection.close()
})

it('64 KiB UTF-8 pending overflow refuses only the new input', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  const first = t.route('pty:write', id, 'a')
  const pending = t.route('pty:write', id, '😀'.repeat(16384))
  await expect(t.route('pty:write', id, 'b')).rejects.toThrow('Terminal input refused.')
  for (let seq = 1; seq <= 17; seq++) {
    await drain()
    t.raw({ type: 'terminal.ack', terminalId: t.terminalId, seq, accepted: true })
  }
  await drain()
  await Promise.all([first, pending])
  const input = t.frames.filter((f) => f.type === 'terminal.input')
  expect(input).toHaveLength(17)
  expect(
    input
      .slice(1)
      .map((f) => f.data)
      .join(''),
  ).toBe('😀'.repeat(16384))
  expect(t.inputDropped).not.toHaveBeenCalled()
  t.connection.close()
})

it('an unaccepted input refuses further input until a fresh reset', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  t.pauseReset()
  const writing = t.route('pty:write', id, 'lost')
  await drain()
  await vi.advanceTimersByTimeAsync(5000)
  await writing
  const before = t.frames.length
  await expect(t.route('pty:write', id, 'next')).rejects.toThrow('Read-only')
  expect(t.frames.slice(before).filter((f) => f.type === 'terminal.input')).toEqual([])
  t.connection.close()
})

it('queued input behind an unaccepted write is rejected at once, never sent', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.noAck()
  t.pauseReset()
  const first = t.route('pty:write', id, 'a')
  await drain()
  const queued = t.route('pty:write', id, 'b').catch((error: Error) => error.message)
  await drain()
  await vi.advanceTimersByTimeAsync(5000)
  await first
  expect(await queued).toBe('Terminal input dropped.')
  expect(t.inputDropped).toHaveBeenCalledTimes(1)
  expect(t.frames.filter((f) => f.type === 'terminal.input').map((f) => f.data)).toEqual(['a'])
  t.connection.close()
})
