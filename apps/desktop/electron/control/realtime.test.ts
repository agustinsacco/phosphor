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
  receive(frame: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }
  reply(index: number): void {
    const frame = this.frames[index]
    this.receive({
      topic: frame?.topic,
      event: 'phx_reply',
      ref: frame?.ref,
      payload: { status: 'ok' },
    })
  }
}
const token = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
function harness(
  target = { url: 'https://test.supabase.co', key: 'public-test-key' },
  random = () => 0,
) {
  let accessToken: string | null = token()
  let generation = 0
  const sockets: Socket[] = []
  const urls: string[] = []
  const changed = vi.fn()
  const joined = vi.fn()
  const log = vi.fn()
  const client = createRealtime({
    log,
    target,
    socket: (url) => {
      const socket = new Socket()
      urls.push(url)
      sockets.push(socket)
      return socket
    },
    accessToken: async () => accessToken,
    generation: () => generation,
    timers: liveTimers,
    now: Date.now,
    random,
    changed,
    joined,
  })
  const latest = (): Socket => {
    const socket = sockets.at(-1)
    if (!socket) throw new Error('no socket')
    return socket
  }
  const join = async (): Promise<Socket> => {
    const socket = latest()
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.reply(0)
    return socket
  }
  return {
    log,
    client,
    sockets,
    urls,
    changed,
    joined,
    latest,
    join,
    token: () => accessToken,
    refresh: () => {
      accessToken = token()
    },
    signOut: () => {
      accessToken = null
    },
    bump: () => {
      generation++
    },
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('joins with the exact frame, keeps tokens out of URLs and refreshes before a heartbeat', async () => {
  const h = harness()
  const socket = await h.join()
  expect(h.urls).toEqual([
    'wss://test.supabase.co/realtime/v1/websocket?apikey=public-test-key&vsn=1.0.0',
  ])
  expect(h.urls[0]).not.toContain(h.token())
  expect(socket.frames[0]).toEqual({
    topic: 'realtime:machines',
    event: 'phx_join',
    ref: '1',
    payload: {
      config: { postgres_changes: [{ event: '*', schema: 'public', table: 'remote_hosts' }] },
      access_token: h.token(),
    },
  })
  expect(h.changed).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(25_000)
  expect(socket.frames[1]).toEqual({ topic: 'phoenix', event: 'heartbeat', ref: '2', payload: {} })
  socket.reply(1)
  h.refresh()
  await vi.advanceTimersByTimeAsync(25_000)
  expect(socket.frames[2]).toMatchObject({
    topic: 'realtime:machines',
    event: 'access_token',
    payload: { access_token: h.token() },
  })
  socket.reply(3)
  h.client.stop()
})
it('reconnects after a missed heartbeat reply and emits changed after rejoin', async () => {
  const h = harness()
  const first = await h.join()
  await vi.advanceTimersByTimeAsync(35_000)
  expect(first.close).toHaveBeenCalledOnce()
  expect(h.sockets).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1000)
  await h.join()
  expect(h.sockets).toHaveLength(2)
  expect(h.changed).toHaveBeenCalledTimes(2)
  h.client.stop()
})
it('doubles backoff to 60 seconds and resets it on acknowledged join', async () => {
  const h = harness()
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    const count = h.sockets.length
    h.latest().onerror?.(new Event('error'))
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(h.sockets).toHaveLength(count)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sockets).toHaveLength(count + 1)
  }
  const socket = await h.join()
  socket.onerror?.(new Event('error'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.latest()).not.toBe(socket)
  h.client.stop()
})
it.each(['bump', 'signOut'] as const)(
  'closes for good after %s, including before async auth returns',
  async (action) => {
    const h = harness()
    const socket = await h.join()
    h[action]()
    await vi.advanceTimersByTimeAsync(25_000)
    expect(socket.close).toHaveBeenCalledOnce()
    const count = h.sockets.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.sockets).toHaveLength(count)
    h.client.stop()
  },
)
it('ignores unknown, binary, malformed and oversized frames and accepts exactly 64 KB', async () => {
  const h = harness()
  const socket = await h.join()
  for (const frame of [
    null,
    [],
    { topic: 'other', event: 'postgres_changes', payload: {} },
    { topic: 'realtime:machines', event: 'other', payload: {} },
  ])
    socket.receive(frame)
  socket.onmessage?.(new MessageEvent('message', { data: new Uint8Array(5) }))
  socket.onmessage?.(new MessageEvent('message', { data: '{' }))
  const base = JSON.stringify({
    topic: 'realtime:machines',
    event: 'postgres_changes',
    payload: { padding: '' },
  })
  const exact = base.replace('"padding":""', `"padding":"${'x'.repeat(65536 - base.length)}"`)
  socket.onmessage?.(new MessageEvent('message', { data: exact.replace('xxx', 'xxxx') }))
  socket.receive({
    topic: 'realtime:machines',
    event: 'postgres_changes',
    payload: { padding: 'é'.repeat(33_000) },
  })
  expect(h.changed).toHaveBeenCalledTimes(1)
  socket.onmessage?.(new MessageEvent('message', { data: exact }))
  socket.receive({ topic: 'realtime:machines', event: 'postgres_changes', payload: {} })
  expect(h.changed).toHaveBeenCalledTimes(3)
  h.client.stop()
})
it('bounds opening and joining, ignores changes before joining and cancels reconnect on stop', async () => {
  const h = harness()
  h.latest().receive({ topic: 'realtime:machines', event: 'postgres_changes', payload: {} })
  expect(h.changed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(h.latest().close).toHaveBeenCalledOnce()
  h.client.stop()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.sockets).toHaveLength(1)
})

it('uses loopback ws and bounds jitter to the maximum backoff', async () => {
  const h = harness({ url: 'http://127.0.0.1:54351', key: 'public-test-key' }, () => 0.5)
  expect(h.urls[0]).toBe(
    'ws://127.0.0.1:54351/realtime/v1/websocket?apikey=public-test-key&vsn=1.0.0',
  )
  h.latest().onerror?.(new Event('error'))
  await vi.advanceTimersByTimeAsync(1099)
  expect(h.sockets).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(h.sockets).toHaveLength(2)
  h.client.stop()
})
it('requires a matching join acknowledgement and heartbeat reply', async () => {
  const h = harness()
  const socket = h.latest()
  socket.receive({
    topic: 'realtime:machines',
    event: 'phx_reply',
    ref: '',
    payload: { status: 'ok' },
  })
  expect(h.changed).not.toHaveBeenCalled()
  await h.join()
  await vi.advanceTimersByTimeAsync(25_000)
  socket.receive({ topic: 'phoenix', event: 'phx_reply', ref: 'wrong', payload: { status: 'ok' } })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(socket.close).toHaveBeenCalledOnce()
  h.client.stop()
})
it('ignores stale socket callbacks without opening two sockets', async () => {
  const h = harness()
  const staleError = h.latest().onerror
  h.latest().onerror?.(new Event('error'))
  staleError?.(new Event('error'))
  await vi.advanceTimersByTimeAsync(2000)
  expect(h.sockets).toHaveLength(2)
  h.client.stop()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.sockets).toHaveLength(2)
})
it('never sends a token if auth finishes after generation changed or sign-out', async () => {
  let generation = 0
  let resolve: ((token: string | null) => void) | undefined
  const socket = new Socket()
  const client = createRealtime({
    target: { url: 'https://test.supabase.co', key: 'public-test-key' },
    socket: () => socket,
    accessToken: () =>
      new Promise((done) => {
        resolve = done
      }),
    generation: () => generation,
    timers: liveTimers,
    now: Date.now,
    random: () => 0,
    changed: vi.fn(),
    joined: vi.fn(),
  })
  socket.open()
  generation++
  resolve?.(token())
  await vi.advanceTimersByTimeAsync(0)
  expect(socket.frames).toEqual([])
  expect(socket.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  client.stop()
})

it.each(['phx_error', 'phx_close', 'join-error'])('reconnects after %s', async (event) => {
  const h = harness()
  const socket = h.latest()
  socket.open()
  await vi.advanceTimersByTimeAsync(0)
  socket.receive(
    event === 'join-error'
      ? {
          topic: 'realtime:machines',
          event: 'phx_reply',
          ref: socket.frames[0]?.ref,
          payload: { status: 'error' },
        }
      : { topic: 'realtime:machines', event, payload: {} },
  )
  expect(socket.close).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.sockets).toHaveLength(2)
  h.client.stop()
})
it('retries factory and auth failures without exposing errors or sending credentials', async () => {
  const socket = new Socket()
  const factory = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('connection failed')
    })
    .mockReturnValue(socket)
  const changed = vi.fn()
  const client = createRealtime({
    target: { url: 'https://test.supabase.co', key: 'public-test-key' },
    socket: factory,
    accessToken: async () => {
      throw new Error('auth unavailable')
    },
    generation: () => 0,
    timers: liveTimers,
    now: Date.now,
    random: () => 0,
    changed,
    joined: vi.fn(),
  })
  await vi.advanceTimersByTimeAsync(1000)
  expect(factory).toHaveBeenCalledTimes(2)
  socket.open()
  await vi.advanceTimersByTimeAsync(0)
  expect(socket.frames).toEqual([])
  expect(socket.close).toHaveBeenCalledOnce()
  expect(changed).not.toHaveBeenCalled()
  client.stop()
})
it('drops auth that finishes after its socket timed out', async () => {
  let resolve: ((value: string | null) => void) | undefined
  const socket = new Socket()
  const client = createRealtime({
    target: { url: 'https://test.supabase.co', key: 'public-test-key' },
    socket: () => socket,
    accessToken: () =>
      new Promise((done) => {
        resolve = done
      }),
    generation: () => 0,
    timers: liveTimers,
    now: Date.now,
    random: () => 0,
    changed: vi.fn(),
    joined: vi.fn(),
  })
  socket.open()
  await vi.advanceTimersByTimeAsync(10_000)
  resolve?.(token())
  await vi.advanceTimersByTimeAsync(0)
  expect(socket.frames).toEqual([])
  expect(socket.close).toHaveBeenCalledOnce()
  client.stop()
})

it('rejects an unsuccessful heartbeat reply and retries a failed heartbeat send', async () => {
  const h = harness()
  const socket = await h.join()
  await vi.advanceTimersByTimeAsync(25_000)
  socket.receive({
    topic: 'phoenix',
    event: 'phx_reply',
    ref: socket.frames[1]?.ref,
    payload: { status: 'error' },
  })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(socket.close).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  const next = await h.join()
  vi.spyOn(next, 'send').mockImplementationOnce(() => {
    throw new Error('send failed')
  })
  await vi.advanceTimersByTimeAsync(25_000)
  expect(next.close).toHaveBeenCalledOnce()
  h.client.stop()
})
it('does not join or reconnect if the initial access token is null', async () => {
  const h = harness()
  h.signOut()
  h.latest().open()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(h.sockets).toHaveLength(1)
  expect(h.latest().frames).toEqual([])
  expect(h.latest().close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  h.client.stop()
})

it('stays silent after stop when a pending auth resolves late (review r1)', async () => {
  let resolve: ((token: string | null) => void) | undefined
  const socket = new Socket()
  const joined = vi.fn()
  const changed = vi.fn()
  const client = createRealtime({
    target: { url: 'https://test.supabase.co', key: 'public-test-key' },
    socket: () => socket,
    accessToken: () =>
      new Promise((done) => {
        resolve = done
      }),
    generation: () => 0,
    timers: liveTimers,
    now: Date.now,
    random: () => 0,
    changed,
    joined,
  })
  socket.open()
  client.stop()
  const calls = joined.mock.calls.length
  // A replacement client may already be joined; this one must not touch shared state.
  resolve?.(token())
  await vi.advanceTimersByTimeAsync(0)
  expect(joined.mock.calls.length).toBe(calls)
  expect(changed).not.toHaveBeenCalled()
  expect(socket.frames).toEqual([])
  client.stop()
  expect(joined.mock.calls.length).toBe(calls)
  expect(vi.getTimerCount()).toBe(0)
})

it('logs joined, errored and left without the socket token or payload', async () => {
  const h = harness()
  const secret = h.token()
  const socket = await h.join()
  expect(h.log).toHaveBeenCalledWith('machines', 'realtime.joined')
  socket.onerror?.(new Event('error'))
  expect(h.log).toHaveBeenCalledWith('machines', 'realtime.errored')
  expect(h.log).toHaveBeenCalledWith('machines', 'realtime.left')
  h.client.stop()
  expect(JSON.stringify(h.log.mock.calls)).not.toContain(secret)
})
