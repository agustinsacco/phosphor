import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createProbeSockets, handleProbeUpgrade } from './probe-socket.mjs'

const origin = 'https://app.example'
const token = 'ab'.repeat(32)
const stops: Array<() => Promise<void>> = []
const peers: WebSocket[] = []
afterEach(async () => {
  for (const peer of peers.splice(0)) peer.terminate()
  await Promise.all(stops.splice(0).map((stop) => stop()))
  vi.useRealTimers()
})

async function start() {
  const state = { origin, token, expiresAt: Date.now() + 300_000, sockets: createProbeSockets() }
  const server = createServer()
  server.on('upgrade', (req, socket, head) => handleProbeUpgrade(state, req, socket, head))
  stops.push(
    () =>
      new Promise<void>((resolve) => {
        for (const peer of state.sockets.clients) peer.terminate()
        state.sockets.close()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  return { state, url: `ws://127.0.0.1:${address.port}/probe` }
}

function firstConnection(connections: Iterable<WebSocket>) {
  const [peer] = connections
  if (!peer) throw new Error('Expected a connected peer')
  return peer
}

function connect(url: string, protocols = ['phosphor-probe', token], from = origin) {
  const peer = new WebSocket(url, protocols, { origin: from })
  peers.push(peer)
  return peer
}

it.each([
  { protocols: [] },
  { protocols: ['phosphor-probe'] },
  { protocols: [token, 'phosphor-probe'] },
  { protocols: ['phosphor-probe', token, 'extra'] },
  { protocols: ['phosphor-probe', token.toUpperCase()] },
  { protocols: ['phosphor-probe', 'cd'.repeat(32)] },
])('requires exactly the ordered protocol and token pair: $protocols', async ({ protocols }) => {
  const { url } = await start()
  const peer = connect(url, protocols)
  expect(((await once(peer, 'error'))[0] as Error).message).toContain('401')
})

it('denies foreign origins, alternate paths and elapsed lifetimes', async () => {
  const { state, url } = await start()
  for (const [path, from] of [
    [url, 'https://other.example'],
    [`${url}?token=${token}`, origin],
  ] as const) {
    const peer = connect(path, undefined, from)
    expect(((await once(peer, 'error'))[0] as Error).message).toContain('401')
  }
  state.expiresAt = Date.now()
  expect(((await once(connect(url), 'error'))[0] as Error).message).toContain('401')
  expect(state.sockets.clients.size).toBe(0)
})

it('bounds active clients at eight and releases admission after close', async () => {
  const { state, url } = await start()
  for (let i = 0; i < 8; i++) await once(connect(url), 'open')
  expect(state.sockets.clients.size).toBe(8)
  expect(((await once(connect(url), 'error'))[0] as Error).message).toContain('401')
  const closed = once(firstConnection(state.sockets.clients), 'close')
  firstConnection(peers).close()
  await closed
  await once(connect(url), 'open')
  expect(state.sockets.clients.size).toBe(8)
})

it('selects only the public protocol, streams numbered ticks and clears its ticker on close', async () => {
  const { state, url } = await start()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const peer = connect(url)
  const ready = once(peer, 'message')
  await once(peer, 'open')
  expect(peer.protocol).toBe('phosphor-probe')
  expect(peer.extensions).toBe('')
  expect(JSON.parse(String((await ready)[0]))).toEqual({ type: 'ready', version: 1 })
  expect(vi.getTimerCount()).toBe(1)
  for (let sequence = 1; sequence <= 2; sequence++) {
    const message = once(peer, 'message')
    vi.advanceTimersByTime(250)
    expect(JSON.parse(String((await message)[0]))).toEqual({ type: 'tick', sequence })
  }
  const closed = once(firstConnection(state.sockets.clients), 'close')
  peer.close()
  await closed
  expect(vi.getTimerCount()).toBe(0)
})

it('answers 32 pings then enforces the per-connection quota', async () => {
  const { url } = await start()
  const peer = connect(url)
  const ready = once(peer, 'message')
  await once(peer, 'open')
  await ready
  const messages: string[] = []
  peer.on('message', (data) => messages.push(String(data)))
  const closed = once(peer, 'close')
  for (let i = 0; i < 33; i++) peer.send('ping')
  const [code, reason] = await closed
  expect(messages.filter((data) => data === JSON.stringify({ type: 'pong' }))).toHaveLength(32)
  expect(code).toBe(1008)
  expect(String(reason)).toBe('Probe messages only')
})

it.each([
  { data: 'not-ping', binary: false, code: 1008 },
  { data: 'ping', binary: true, code: 1008 },
  { data: 'x'.repeat(64), binary: false, code: 1008 },
  { data: 'x'.repeat(65), binary: false, code: 1009 },
])('bounds text, binary and payload size: $binary / $code', async ({ data, binary, code }) => {
  const { url } = await start()
  const peer = connect(url)
  await once(peer, 'open')
  const closed = once(peer, 'close')
  peer.send(data, { binary })
  expect((await closed)[0]).toBe(code)
})

it('closes messages at expiry with the policy reason', async () => {
  const { state, url } = await start()
  const peer = connect(url)
  await once(peer, 'open')
  state.expiresAt = Date.now()
  const closed = once(peer, 'close')
  peer.send('ping')
  const [code, reason] = await closed
  expect(code).toBe(1008)
  expect(String(reason)).toBe('Probe messages only')
})

it.each(['expiry', 'backpressure', 'error'])(
  'terminates and clears timers on %s',
  async (cause) => {
    const { state, url } = await start()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const peer = connect(url)
    const ready = once(peer, 'message')
    await once(peer, 'open')
    await ready
    const accepted = firstConnection(state.sockets.clients)
    const serverClosed = new Promise<void>((resolve) => accepted.once('close', () => resolve()))
    const clientClosed = once(peer, 'close')
    if (cause === 'expiry') state.expiresAt = Date.now()
    if (cause === 'backpressure') {
      Object.defineProperty(accepted, 'bufferedAmount', { configurable: true, value: 4096 })
      const tick = once(peer, 'message')
      vi.advanceTimersByTime(250)
      expect(JSON.parse(String((await tick)[0]))).toEqual({ type: 'tick', sequence: 1 })
      Object.defineProperty(accepted, 'bufferedAmount', { value: 4097 })
    }
    if (cause === 'error') accepted.emit('error', new Error('Synthetic transport error'))
    else vi.advanceTimersByTime(250)
    await serverClosed
    expect((await clientClosed)[0]).toBe(1006)
    expect(vi.getTimerCount()).toBe(0)
  },
)
