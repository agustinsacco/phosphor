import { afterEach, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { createProbe } from './remote-probe.mjs'

const origin = 'https://app.example'
const token = 'a1'.repeat(32)
const stops: Array<() => Promise<unknown>> = []
const peers: WebSocket[] = []
afterEach(async () => {
  for (const peer of peers.splice(0)) peer.terminate()
  await Promise.all(stops.splice(0).map((stop) => stop()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function start() {
  const probe = await createProbe({ origin, token })
  stops.push(probe.close)
  return probe
}

function connect(url: string, protocols = ['phosphor-probe', token], from = origin) {
  const peer = new WebSocket(url.replace('http:', 'ws:'), protocols, { origin: from })
  peers.push(peer)
  return peer
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected captured connection or timer')
  return value
}

function captureConnections() {
  const accepted: WebSocket[] = []
  const original = WebSocketServer.prototype.handleUpgrade
  vi.spyOn(WebSocketServer.prototype, 'handleUpgrade').mockImplementation(function (
    this: WebSocketServer,
    request,
    socket,
    head,
    callback,
  ) {
    return original.call(this, request, socket, head, (peer, req) => {
      accepted.push(peer)
      callback(peer, req)
    })
  })
  return accepted
}

it('pins exact HTTPS origin, lowercase 32-byte hex token and lifetime configuration', async () => {
  for (const options of [
    { origin: 'https://app.example/' },
    { origin: 'http://app.example' },
    { token: token.toUpperCase() },
    { token: 'a'.repeat(63) },
    { ttlMs: 0 },
    { ttlMs: 1.5 },
    { ttlMs: 300_001 },
  ])
    await expect(createProbe({ origin, token, ...options })).rejects.toThrow()
})

it('pins HTTP origin, authorization and elapsed-lifetime denials', async () => {
  const probe = await start()
  const headers = { Origin: origin, Authorization: `Bearer ${token}` }
  for (const from of ['', 'null', `${origin}/`, 'https://other.example']) {
    const response = await fetch(probe.url, { headers: { ...headers, Origin: from } })
    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  }
  for (const authorization of ['', token, `bearer ${token}`, `Bearer ${token.toUpperCase()}`])
    expect(
      (await fetch(probe.url, { headers: { ...headers, Authorization: authorization } })).status,
    ).toBe(401)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(probe.expiresAt)
  expect((await fetch(probe.url, { headers })).status).toBe(403)
})

it.each([
  { protocols: [], from: origin, path: '/probe' },
  { protocols: [token, 'phosphor-probe'], from: origin, path: '/probe' },
  { protocols: ['phosphor-probe', token, 'extra'], from: origin, path: '/probe' },
  { protocols: ['phosphor-probe', token.toUpperCase()], from: origin, path: '/probe' },
  { protocols: ['phosphor-probe', token], from: 'https://other.example', path: '/probe' },
  { protocols: ['phosphor-probe', token], from: origin, path: `/probe?token=${token}` },
])('pins upgrade denial for $protocols / $from / $path', async ({ protocols, from, path }) => {
  const probe = await start()
  const peer = connect(probe.url.replace('/probe', path), protocols, from)
  expect(((await once(peer, 'error'))[0] as Error).message).toContain('401')
})

it('pins upgrade denial at the exact expiration boundary', async () => {
  const probe = await start()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(probe.expiresAt)
  const peer = connect(probe.url)
  expect(((await once(peer, 'error'))[0] as Error).message).toContain('401')
})

it('admits eight clients, refuses the ninth and readmits after a disconnect', async () => {
  const accepted = captureConnections()
  const probe = await start()
  for (let i = 0; i < 8; i++) await once(connect(probe.url), 'open')
  expect(((await once(connect(probe.url), 'error'))[0] as Error).message).toContain('401')
  const closed = once(required(accepted[0]), 'close')
  required(peers[0]).terminate()
  await closed
  await once(connect(probe.url), 'open')
  expect(accepted).toHaveLength(9)
})

it('answers exactly 32 pings before closing with the policy code and reason', async () => {
  const probe = await start()
  const peer = connect(probe.url)
  const ready = once(peer, 'message')
  await once(peer, 'open')
  expect(JSON.parse(String((await ready)[0]))).toEqual({ type: 'ready', version: 1 })
  const messages: string[] = []
  peer.on('message', (data) => messages.push(String(data)))
  const closed = once(peer, 'close')
  for (let i = 0; i < 33; i++) peer.send('ping')
  const [code, reason] = await closed
  expect(
    messages.map((data) => JSON.parse(data)).filter((data) => data.type === 'pong'),
  ).toHaveLength(32)
  expect(code).toBe(1008)
  expect(String(reason)).toBe('Probe messages only')
})

it.each([
  { data: 'other', binary: false, code: 1008 },
  { data: 'ping', binary: true, code: 1008 },
  { data: 'a'.repeat(65), binary: false, code: 1009 },
])('pins message policy for $data / binary=$binary', async ({ data, binary, code }) => {
  const probe = await start()
  const peer = connect(probe.url)
  await once(peer, 'open')
  const closed = once(peer, 'close')
  peer.send(data, { binary })
  expect((await closed)[0]).toBe(code)
})

it('rejects messages at expiry even before the lifetime timer fires', async () => {
  const probe = await start()
  const peer = connect(probe.url)
  await once(peer, 'open')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(probe.expiresAt)
  const closed = once(peer, 'close')
  peer.send('ping')
  expect((await closed)[0]).toBe(1008)
})

it('allows 4096 buffered bytes but terminates above the backpressure limit', async () => {
  const accepted = captureConnections()
  const probe = await start()
  const peer = connect(probe.url)
  await once(peer, 'open')
  Object.defineProperty(accepted[0], 'bufferedAmount', { configurable: true, value: 4096 })
  expect(JSON.parse(String((await once(peer, 'message'))[0]))).toEqual({
    type: 'tick',
    sequence: 1,
  })
  Object.defineProperty(accepted[0], 'bufferedAmount', { value: 4097 })
  expect((await once(peer, 'close'))[0]).toBe(1006)
})

it('terminates on a tick at expiry and clears that connection ticker', async () => {
  const clear = vi.spyOn(globalThis, 'clearInterval')
  const setTicker = vi.spyOn(globalThis, 'setInterval')
  const probe = await start()
  const peer = connect(probe.url)
  await once(peer, 'open')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(probe.expiresAt)
  expect((await once(peer, 'close'))[0]).toBe(1006)
  const ticker = required(setTicker.mock.results[0]).value
  await vi.waitFor(() => expect(clear).toHaveBeenCalledWith(ticker))
})

it('returns one shutdown promise, clears expiry and tickers, and terminates streams', async () => {
  const clearTicker = vi.spyOn(globalThis, 'clearInterval')
  const setTicker = vi.spyOn(globalThis, 'setInterval')
  const clearExpiry = vi.spyOn(globalThis, 'clearTimeout')
  const setExpiry = vi.spyOn(globalThis, 'setTimeout')
  const probe = await start()
  const expiry = required(
    setExpiry.mock.results[setExpiry.mock.calls.findIndex((args) => args[1] === 300_000)],
  ).value
  const peer = connect(probe.url)
  await once(peer, 'open')
  const closed = once(peer, 'close')
  const stopped = probe.close()
  expect(probe.close()).toBe(stopped)
  expect(clearExpiry.mock.calls.filter(([timer]) => timer === expiry)).toHaveLength(1)
  await stopped
  expect((await closed)[0]).toBe(1006)
  const ticker = required(setTicker.mock.results[0]).value
  await vi.waitFor(() => expect(clearTicker).toHaveBeenCalledWith(ticker))
  expect(probe.close()).toBe(stopped)
  await expect(fetch(probe.url, { headers: { Origin: origin } })).rejects.toThrow()
})
