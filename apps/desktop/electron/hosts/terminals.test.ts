// DM-18 frozen inventory: 57 cases; full original names recorded in the characterization commit.
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { drain, setup } from './__fixtures__/terminals'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('gap redraw resets exactly once and drops duplicate output', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.output(1, 'one')
  await drain()
  t.output(1, 'duplicate')
  await drain()
  t.output(3, 'gap')
  await drain()
  t.output(4, 'four')
  await drain()
  expect(t.emit.mock.calls.map((c) => c[2])).toEqual(['one', '\x1bcprompt', 'four'])
  t.connection.close()
})

it.each(['pty:write', 'pty:resize', 'pty:kill'] as const)(
  'viewer refuses %s in main without sending',
  async (channel) => {
    const t = await setup()
    t.viewer()
    await drain()
    const id = await t.create()
    await t.attach(id)
    const before = t.frames.length
    await expect(t.route(channel, id, channel === 'pty:write' ? 'secret' : 80, 24)).rejects.toThrow(
      'Read-only',
    )
    expect(t.frames.slice(before)).toEqual([])
    expect(t.frames.some((f) => f.type === 'command')).toBe(false)
    t.connection.close()
  },
)

it('capability loss rejects create and existing ops after reconnect', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.loseCapability()
  await t.reconnect()
  await expect(t.route('pty:write', id, 'input')).rejects.toThrow('Not available')
  await expect(t.create()).rejects.toThrow('Not available')
  t.connection.close()
})

it('stale handle after create await never delivers an id', async () => {
  const t = await setup()
  t.delayReceipt()
  const creating = t.create()
  const rejected = expect(creating).rejects.toThrow('Not available')
  await drain()
  t.setCurrent()
  t.receipt()
  await drain()
  await rejected
  t.connection.close()
})

it('disposed or replaced handle invalidates mapping and Host restart ends it', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.setCurrent()
  t.bridge.reconcile()
  expect(t.emit).toHaveBeenCalledWith(1, `pty:exit:${id}`, 0)
  await expect(t.route('pty:write', id, 'input')).rejects.toThrow('Not available')
  t.connection.close()
  const r = await setup(),
    rid = await r.create()
  await r.attach(rid)
  await r.reconnect(true)
  r.bridge.reconcile()
  expect(r.emit).toHaveBeenCalledWith(1, `pty:exit:${rid}`, 0)
  await expect(r.route('pty:write', rid, 'input')).rejects.toThrow('Not available')
  r.connection.close()
})

it('interrupted reset shows ended and refuses input', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.interrupt()
  await drain()
  await vi.advanceTimersByTimeAsync(0)
  expect(t.emit).toHaveBeenCalledWith(1, `pty:exit:${id}`, 0)
  await expect(t.route('pty:write', id, 'input')).rejects.toThrow('Read-only')
  t.connection.close()
})

it('viewer lists existing terminals once per identity and receives the fixed empty message', async () => {
  const t = await setup()
  t.viewer()
  await drain()
  const id = await t.create()
  expect(await t.create()).toBe(id)
  expect(t.frames.filter((f) => f.type === 'call')).toMatchObject([
    { method: 'terminal.list', params: { laneId: t.lane.laneId } },
    { method: 'terminal.list', params: { laneId: t.lane.laneId } },
  ])
  expect(t.frames.some((f) => f.type === 'command')).toBe(false)
  t.empty()
  await expect(t.create()).rejects.toThrow('Read-only: no terminals available.')
  t.connection.close()
})

it.each(['terminal', 'sessions.control'] as const)(
  'loss of %s refuses write, resize and kill even after a fresh reset',
  async (cap) => {
    const t = await setup(),
      id = await t.create()
    await t.attach(id)
    t.loseCapability(cap)
    await t.reconnect()
    t.reset()
    await drain()
    const before = t.frames.length
    for (const channel of ['pty:write', 'pty:resize', 'pty:kill'] as const)
      await expect(
        t.route(channel, id, channel === 'pty:write' ? 'private' : 80, 24),
      ).rejects.toThrow()
    expect(t.frames.slice(before)).toEqual([])
    t.connection.close()
  },
)

it('lost controller on reconnect remains read-only after reset', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.viewer()
  await t.reconnect()
  for (const channel of ['pty:write', 'pty:resize', 'pty:kill'] as const)
    await expect(
      t.route(channel, id, channel === 'pty:write' ? 'private' : 80, 24),
    ).rejects.toThrow('Read-only')
  t.connection.close()
})

it('rejects malformed dimensions and oversized input without sending', async () => {
  const t = await setup()
  await expect(t.route('pty:create', 'host:test/repo', 1001, 24, 'session')).rejects.toThrow(
    'Invalid',
  )
  const id = await t.create()
  await t.attach(id)
  const before = t.frames.length
  await expect(t.route('pty:resize', id, 80, 0)).rejects.toThrow('Invalid')
  await expect(t.route('pty:write', id, 'x'.repeat(65537))).rejects.toThrow('refused')
  expect(t.frames.slice(before)).toEqual([])
  t.connection.close()
})

it('stream gap suspends mutations until its replacement reset', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.pauseReset()
  t.output(2, 'gap')
  await drain()
  await expect(t.route('pty:resize', id, 80, 24)).rejects.toThrow('Read-only')
  t.connection.close()
})

it('new socket without pending input requires a reset before any mutation', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.pauseReset()
  await t.reconnect()
  await expect(t.route('pty:resize', id, 80, 24)).rejects.toThrow('Read-only')
  t.connection.close()
})

it('another window cannot attach or mutate an opaque terminal', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  for (const channel of ['pty:attach', 'pty:write', 'pty:resize', 'pty:kill'] as const) {
    const routed = t.bridge.route(2, channel, [id, 'private', 24])
    if (!routed) throw new Error('Not routed')
    await expect(routed.result).rejects.toThrow('Not available')
  }
  t.connection.close()
})

it('control lost during create await never returns a terminal identity', async () => {
  const t = await setup()
  t.delayReceipt()
  const creating = t.create()
  const rejected = expect(creating).rejects.toThrow('Not available')
  await drain()
  t.viewer()
  t.receipt()
  await drain()
  await rejected
  t.connection.close()
})

it('malformed Host terminal results fail closed with fixed messages', async () => {
  const t = await setup()
  vi.spyOn(t.connection, 'send').mockResolvedValue({
    requestId: randomUUID(),
    status: 'done',
    data: { terminalId: '/private' },
  })
  await expect(t.create()).rejects.toThrow('Terminal creation not confirmed.')
  t.viewer()
  await drain()
  vi.spyOn(t.connection, 'call').mockResolvedValue({
    type: 'result',
    id: randomUUID(),
    ok: true,
    data: [{ terminalId: t.terminalId, laneId: '/private', status: 'running' }],
  })
  await expect(t.create()).rejects.toThrow('Read-only: no terminals available.')
  t.connection.close()
})

it('attach timeout closes its watch, ignores late reset, and allows fresh attach', async () => {
  const t = await setup(),
    id = await t.create()
  t.pauseReset()
  const attaching = t.route('pty:attach', id)
  const rejected = expect(attaching).rejects.toThrow('Terminal unavailable.')
  await drain()
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  t.reset('late')
  await drain()
  expect(t.emit).not.toHaveBeenCalled()
  expect(t.frames.filter((f) => f.type === 'unsubscribe')).toHaveLength(1)
  await expect(t.route('pty:write', id, 'a')).rejects.toThrow('Read-only')
  const retry = t.route('pty:attach', id)
  await drain()
  t.reset('fresh')
  await drain()
  expect(await retry).toEqual({ scrollback: 'fresh' })
  t.connection.close()
})

it('a Host restart never rebinds a terminal, even before reconcile runs', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  t.emit.mockClear()
  await t.reconnect(true)
  await drain()
  const before = t.frames.length
  await expect(t.route('pty:write', id, 'after restart')).rejects.toThrow('Not available')
  expect(t.frames.slice(before).filter((f) => f.type === 'terminal.input')).toEqual([])
  expect(t.emit.mock.calls.filter((c) => String(c[1]).startsWith('pty:data:'))).toEqual([])
  t.connection.close()
})

it('another window cannot receive an existing terminal identity from create', async () => {
  const t = await setup(),
    id = await t.create()
  await t.attach(id)
  const routed = t.bridge.route(2, 'pty:create', [`host:${t.lane.laneId}/repo`, 80, 24, 'session'])
  if (!routed) throw new Error('Not routed')
  const pending = routed.result
  await drain()
  await expect(pending).rejects.toThrow('Not available')
  t.connection.close()
})

it('a superseded attach timeout leaves the newer attach synchronized', async () => {
  const t = await setup(),
    id = await t.create()
  t.pauseReset()
  const first = t.route('pty:attach', id).catch((error: Error) => error.message)
  await drain()
  await vi.advanceTimersByTimeAsync(3000)
  // The second subscribe must reach the Host before its reset is sent.
  const second = t.route('pty:attach', id)
  await drain()
  t.reset('fresh')
  await drain()
  expect(await second).toEqual({ scrollback: 'fresh' })
  await vi.advanceTimersByTimeAsync(3000)
  expect(await first).toBe('Terminal unavailable.')
  const writing = t.route('pty:write', id, 'still live')
  await drain()
  await writing
  expect(t.frames.filter((f) => f.type === 'terminal.input')).toMatchObject([
    { seq: 1, data: 'still live' },
  ])
  t.connection.close()
})
