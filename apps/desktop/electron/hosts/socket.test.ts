import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { openHostSocket } from './socket'

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
