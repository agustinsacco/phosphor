import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRealtime, liveTimers, type RealtimeSocket } from './realtime'

class Socket implements RealtimeSocket {
  onopen: RealtimeSocket['onopen'] = null
  onclose: RealtimeSocket['onclose'] = null
  onerror: RealtimeSocket['onerror'] = null
  onmessage: RealtimeSocket['onmessage'] = null
  frames: { topic: string; event: string; payload: unknown; ref: string }[] = []
  close = vi.fn()
  send(data: string): void {
    this.frames.push(JSON.parse(data))
  }
  open(): void {
    this.onopen?.(new Event('open'))
  }
  receive(event: string, ref = '', topic = 'realtime:machines'): void {
    this.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({ topic, event, ref, payload: { status: 'ok' } }),
      }),
    )
  }
}

function harness(accessToken: () => Promise<string | null> = async () => 'initial-token') {
  const sockets: Socket[] = []
  const changed = vi.fn()
  const joined = vi.fn()
  const log = vi.fn()
  const client = createRealtime({
    target: { url: 'https://test.supabase.co', key: 'public-key' },
    socket: () => {
      const socket = new Socket()
      sockets.push(socket)
      return socket
    },
    accessToken,
    generation: () => 0,
    timers: liveTimers,
    now: Date.now,
    random: () => 1,
    changed,
    joined,
    log,
  })
  const latest = (): Socket => {
    const socket = sockets.at(-1)
    if (!socket) throw new Error('missing socket')
    return socket
  }
  const join = async (): Promise<Socket> => {
    const socket = latest()
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.receive('phx_reply', socket.frames[0]?.ref)
    return socket
  }
  return { client, sockets, latest, join, changed, joined, log }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('keeps a replacement joined when stopped auth resolves late and stop repeats', async () => {
  let resolve: ((token: string | null) => void) | undefined
  const old = harness(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const socket = old.latest()
  socket.open()
  old.client.stop()
  const replacement = harness()
  await replacement.join()
  old.joined.mockClear()
  resolve?.('late-secret')
  await vi.advanceTimersByTimeAsync(0)
  old.client.stop()
  expect(old.joined).not.toHaveBeenCalled()
  expect(old.changed).not.toHaveBeenCalled()
  expect(socket.frames).toEqual([])
  expect(socket.close).toHaveBeenCalledOnce()
  expect(replacement.joined.mock.calls).toEqual([[true]])
  replacement.client.stop()
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds pending heartbeat authentication at ten seconds and drops its late token', async () => {
  let resolve: ((token: string | null) => void) | undefined
  const auth = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce('initial-token')
  auth.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const h = harness(auth)
  const socket = await h.join()
  await vi.advanceTimersByTimeAsync(34_999)
  expect(socket.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(socket.close).toHaveBeenCalledOnce()
  resolve?.('late-secret')
  await vi.advanceTimersByTimeAsync(0)
  expect(socket.frames).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1200)
  expect(h.sockets).toHaveLength(2)
  h.client.stop()
})

it('keeps a heartbeat deadline until its matching successful reply', async () => {
  const h = harness()
  const socket = await h.join()
  await vi.advanceTimersByTimeAsync(25_000)
  socket.receive('phx_reply', 'wrong', 'phoenix')
  await vi.advanceTimersByTimeAsync(9999)
  expect(socket.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(socket.close).toHaveBeenCalledOnce()
  h.client.stop()
})

it('refreshes only a changed token before heartbeat without logging credentials', async () => {
  let token = 'initial-secret'
  const h = harness(async () => token)
  const socket = await h.join()
  await vi.advanceTimersByTimeAsync(25_000)
  expect(socket.frames.map((frame) => frame.event)).toEqual(['phx_join', 'heartbeat'])
  socket.receive('phx_reply', socket.frames[1]?.ref, 'phoenix')
  token = 'refreshed-secret'
  await vi.advanceTimersByTimeAsync(25_000)
  expect(socket.frames.slice(2)).toEqual([
    {
      topic: 'realtime:machines',
      event: 'access_token',
      payload: { access_token: token },
      ref: '3',
    },
    { topic: 'phoenix', event: 'heartbeat', payload: {}, ref: '4' },
  ])
  socket.receive('phx_reply', '4', 'phoenix')
  await vi.advanceTimersByTimeAsync(25_000)
  expect(socket.frames.at(-1)?.event).toBe('heartbeat')
  expect(socket.frames.filter((frame) => frame.event === 'access_token')).toHaveLength(1)
  h.client.stop()
  expect(JSON.stringify(h.log.mock.calls)).not.toContain('secret')
})

it('caps jittered retry at sixty seconds and cancels the only retry on stop', async () => {
  const h = harness()
  for (const delay of [1200, 2400, 4800, 9600, 19200, 38400, 60_000, 60_000]) {
    const count = h.sockets.length
    h.latest().onerror?.(new Event('error'))
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(h.sockets).toHaveLength(count)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sockets).toHaveLength(count + 1)
  }
  h.latest().onerror?.(new Event('error'))
  h.client.stop()
  h.client.stop()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(h.sockets).toHaveLength(9)
  expect(vi.getTimerCount()).toBe(0)
})

it('announces a join once and delivers changes only after the matching join reply', async () => {
  const h = harness()
  const socket = h.latest()
  socket.receive('postgres_changes')
  socket.open()
  await vi.advanceTimersByTimeAsync(0)
  socket.receive('phx_reply', 'wrong')
  socket.receive('postgres_changes')
  expect(h.changed).not.toHaveBeenCalled()
  socket.receive('phx_reply', '1')
  socket.receive('phx_reply', '1')
  expect(h.joined.mock.calls).toEqual([[true]])
  expect(h.changed).toHaveBeenCalledOnce()
  socket.receive('postgres_changes', '', 'other')
  expect(h.changed).toHaveBeenCalledOnce()
  socket.receive('postgres_changes')
  expect(h.changed).toHaveBeenCalledTimes(2)
  h.client.stop()
})
