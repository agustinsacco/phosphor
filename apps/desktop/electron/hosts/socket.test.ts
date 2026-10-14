import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { e2eHostEndpoint, hostSocketUrl, openHostSocket } from './socket'

// A loopback-only RFC 6455 handshake and close echo. No Host or credentials.
async function server() {
  const http = createServer()
  const sockets = new Set<Duplex>()
  let resolveClose: (value: { code: number; reason: string }) => void = () => {}
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClose = resolve
  })
  http.on('upgrade', (request, socket) => {
    sockets.add(socket)
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    let data = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk])
      const size = (data[1] ?? 0) & 127
      if (data.length < 6 + size) return
      expect(data[0]).toBe(0x88)
      expect(data[1]).toBe(0x80 | size)
      const payload = Buffer.from(data.subarray(6, 6 + size))
      for (let i = 0; i < size; i++) payload[i] = (payload[i] ?? 0) ^ (data[2 + (i % 4)] ?? 0)
      resolveClose({ code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') })
      socket.end(Buffer.concat([Buffer.from([0x88, size]), payload]))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('No loopback address')
  return {
    url: `ws://127.0.0.1:${address.port}`,
    closed,
    stop: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

it.each([
  { code: 1001, reason: 'x'.repeat(200), expectedCode: 1000, expectedReason: 'x'.repeat(123) },
  { code: 4400, reason: '😀'.repeat(40), expectedCode: 4400, expectedReason: '😀'.repeat(30) },
  { code: 1000, reason: 'x'.repeat(123), expectedCode: 1000, expectedReason: 'x'.repeat(123) },
])('clamps real WHATWG closes to valid codes and UTF-8 bytes: $code', async (t) => {
  const s = await server()
  const log = vi.fn()
  try {
    const socket = await openHostSocket(s.url, log)
    expect(() => socket.close(t.code, t.reason)).not.toThrow()
    expect(log).not.toHaveBeenCalled()
    expect(await s.closed).toEqual({ code: t.expectedCode, reason: t.expectedReason })
  } finally {
    await s.stop()
  }
})

it('swallows close exceptions and logs no reason or exception text', async () => {
  const s = await server()
  const log = vi.fn()
  try {
    const socket = await openHostSocket(s.url, log)
    const close = vi.spyOn(WebSocket.prototype, 'close').mockImplementation(() => {
      throw new Error('private exception')
    })
    try {
      expect(() => socket.close(1000, 'private reason')).not.toThrow()
      expect(log.mock.calls).toEqual([['hosts', 'close_failed']])
    } finally {
      close.mockRestore()
      socket.close(1000, '')
    }
  } finally {
    await s.stop()
  }
})

it('admits only an explicit dev loopback origin and downgrades only that stream', () => {
  const endpoint = 'https://127.0.0.1:47615'
  expect(e2eHostEndpoint({ PHOSPHOR_E2E_HOST_ENDPOINT: endpoint }, false)).toBe(endpoint)
  expect(e2eHostEndpoint({ PHOSPHOR_E2E_HOST_ENDPOINT: endpoint }, true)).toBeUndefined()
  expect(e2eHostEndpoint({}, false)).toBeUndefined()
  for (const port of [1024, 65535]) {
    const value = `https://127.0.0.1:${port}`
    expect(e2eHostEndpoint({ PHOSPHOR_E2E_HOST_ENDPOINT: value }, false)).toBe(value)
  }
  for (const value of [
    'https://localhost:47615',
    'https://127.0.0.2:47615',
    'https://[::1]:47615',
    'https://127.0.0.1:1023',
    'https://127.0.0.1:65536',
    'https://127.0.0.1:04761',
    endpoint + '/',
    endpoint + '/private',
    endpoint + '?key=value',
    endpoint + '#secret',
    'https://user@127.0.0.1:47615',
    'http://127.0.0.1:47615',
  ])
    expect(e2eHostEndpoint({ PHOSPHOR_E2E_HOST_ENDPOINT: value }, false)).toBeUndefined()
  expect(hostSocketUrl('wss://127.0.0.1:47615/v1/stream', endpoint)).toBe(
    'ws://127.0.0.1:47615/v1/stream',
  )
  for (const url of [
    'wss://127.0.0.1:47616/v1/stream',
    'wss://localhost:47615/v1/stream',
    'wss://127.0.0.2:47615/v1/stream',
    'wss://bee.tail.ts.net/v1/stream',
    'wss://127.0.0.1:47615/other',
  ]) {
    expect(hostSocketUrl(url, endpoint)).toBe(url)
    expect(hostSocketUrl(url)).toBe(url)
  }
})
