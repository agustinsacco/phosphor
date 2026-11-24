import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { FrameSocket } from '@phosphor/shared/host-protocol'
import { createWsUpgrade, type StreamConnection } from './ws-upgrade'

const LIMITS = { connections: 1, rejecting: 4, closeGraceMs: 2000 }

let server: Server | undefined
let upgrades: ReturnType<typeof createWsUpgrade<StreamConnection>> | undefined
afterEach(async () => {
  await upgrades?.close(1001)
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = upgrades = undefined
})

/** A loopback listener on an ephemeral port that feeds its upgrades to the wrapper. */
async function listen(options: { status?: number; accepting?: boolean } = {}) {
  const sockets: FrameSocket[] = []
  const connection = { close: vi.fn(), rejectFrame: vi.fn() }
  const wrapper = createWsUpgrade({
    status: () => options.status ?? 0,
    accepting: () => options.accepting ?? true,
    limits: LIMITS,
    sendQueueBytes: 1024,
    connect: (socket) => {
      sockets.push(socket)
      return connection
    },
  })
  upgrades = wrapper
  const http = createServer()
  server = http
  http.on('upgrade', wrapper.upgrade)
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const { port } = http.address() as AddressInfo
  const open = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`)
    // A refused or terminated handshake reports an error the assertions already cover.
    ws.on('error', () => {})
    return ws
  }
  return { sockets, connection, open, wrapper }
}

async function refusal(ws: WebSocket) {
  const [, response] = (await once(ws, 'unexpected-response')) as [unknown, { statusCode: number }]
  ws.terminate()
  return response.statusCode
}

describe('WebSocket upgrade wrapper', () => {
  it('refuses with the route status, and with 503 while not accepting', async () => {
    expect(await refusal((await listen({ status: 404 })).open())).toBe(404)
    await upgrades?.close(1001)
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    expect(await refusal((await listen({ accepting: false })).open())).toBe(503)
  })

  it('hands text frames to the connection and refuses binary ones', async () => {
    const host = await listen()
    const ws = host.open()
    await once(ws, 'open')
    await vi.waitFor(() => expect(host.sockets).toHaveLength(1))
    const socket = host.sockets[0]
    if (!socket) throw new Error('no socket')
    const received: string[] = []
    socket.onMessage((text) => received.push(text))
    ws.send('hello')
    ws.send(Buffer.from('bytes'), { binary: true })
    await vi.waitFor(() => expect(host.connection.rejectFrame).toHaveBeenCalledOnce())
    expect(received).toEqual(['hello'])
    expect(socket.isOpen()).toBe(true)
    expect([...host.wrapper.connections()]).toEqual([host.connection])
    const closed = once(ws, 'close')
    socket.close(4400, '4400')
    expect((await closed)[0]).toBe(4400)
    await vi.waitFor(() => expect([...host.wrapper.connections()]).toEqual([]))
  })

  it('closes a socket past the connection limit with 4429 without building a connection', async () => {
    const host = await listen()
    const first = host.open()
    await once(first, 'open')
    const over = host.open()
    const [code] = (await once(over, 'close')) as [number]
    expect(code).toBe(4429)
    expect(host.sockets).toHaveLength(1)
    first.terminate()
  })

  it('closes every connection and socket with the given code', async () => {
    const host = await listen()
    const ws = host.open()
    await once(ws, 'open')
    await vi.waitFor(() => expect(host.sockets).toHaveLength(1))
    const closed = once(ws, 'close')
    await host.wrapper.close(1001)
    expect(host.connection.close).toHaveBeenCalledWith(1001)
    expect((await closed)[0]).toBe(1001)
  })
})
