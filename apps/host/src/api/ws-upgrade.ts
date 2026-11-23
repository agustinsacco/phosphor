import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { HOST_LIMITS, type FrameSocket } from '@phosphor/shared/host-protocol'

/** Answers a refused request on its raw transport, then destroys the transport. */
export function rejectTransport(transport: Duplex, status = 429) {
  transport.write(
    `HTTP/1.1 ${status} ${status === 429 ? 'Too Many Requests' : 'Rejected'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => transport.destroy(),
  )
}

/** What a stream socket feeds: the connection the listener built for it. */
export interface StreamConnection {
  close(code: number): void
  /** A binary frame arrived; the connection decides the close code. */
  rejectFrame(): void
}

export interface WsUpgradeOptions<C extends StreamConnection> {
  /** The HTTP status that refuses this upgrade request, or 0 to accept it. */
  status(request: IncomingMessage): number
  /** False refuses every upgrade with 503: the listener stopped or has no authority yet. */
  accepting(): boolean
  limits: { connections: number; rejecting: number; closeGraceMs: number }
  /** The send queue bound that ping and pong control frames respect. */
  sendQueueBytes: number
  /** Builds the connection for an accepted socket. `ping` sends a WebSocket ping. */
  connect(socket: FrameSocket, ping: () => void): C
}

/** Closes sockets once, and terminates any that do not close within the grace. */
function socketCloser(closeGraceMs: number) {
  const closing = new WeakSet<WebSocket>()
  function terminateAfterGrace(ws: WebSocket) {
    const timer = setTimeout(() => ws.terminate(), closeGraceMs)
    timer.unref()
    ws.once('close', () => clearTimeout(timer))
  }
  return {
    close(ws: WebSocket, code: number) {
      if (closing.has(ws)) return
      closing.add(ws)
      ws.close(code)
      terminateAfterGrace(ws)
    },
    /** A socket error: terminate after the grace unless a close already began. */
    failed(ws: WebSocket) {
      if (!closing.has(ws)) {
        closing.add(ws)
        terminateAfterGrace(ws)
      }
    },
  }
}

/** The text-frame socket a connection sees over one WebSocket. Binary frames are refused. */
function frameSocket(
  ws: WebSocket,
  close: (code: number) => void,
  connection: () => StreamConnection,
): FrameSocket {
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text)
    },
    close,
    onMessage: (cb) =>
      ws.on('message', (data, binary) => {
        if (binary) {
          connection().rejectFrame()
          return
        }
        cb(data.toString())
      }),
    onClose: (cb) => ws.on('close', (code) => cb(code, '')),
    isOpen: () => ws.readyState === WebSocket.OPEN,
    bufferedBytes: () => ws.bufferedAmount,
  }
}

/**
 * The WebSocket side of a listener: route check, admission, `handleUpgrade`,
 * and the sockets it hands to connections. A listener feeds it its `upgrade` events.
 */
export function createWsUpgrade<C extends StreamConnection>(options: WsUpgradeOptions<C>) {
  const { limits } = options
  let rejecting = 0
  const closer = socketCloser(limits.closeGraceMs)
  const connections = new Map<WebSocket, C>()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: HOST_LIMITS.inboundFrameBytes,
    perMessageDeflate: false,
    autoPong: false,
  })
  wss.on('error', () => {})
  function accept(ws: WebSocket) {
    ws.on('error', () => closer.failed(ws))
    if (wss.clients.size > limits.connections) {
      rejecting++
      ws.once('close', () => {
        rejecting--
      })
      closer.close(ws, 4429)
      return
    }
    const socket = frameSocket(
      ws,
      (code) => closer.close(ws, code),
      () => connection,
    )
    function controlFrame(data?: Buffer) {
      if (ws.readyState !== WebSocket.OPEN) return
      if (socket.bufferedBytes() + (data?.length ?? 0) > options.sendQueueBytes) {
        closer.close(ws, 4429)
        return
      }
      if (data) ws.pong(data)
      else ws.ping()
    }
    ws.on('ping', (data) => controlFrame(data))
    const connection = options.connect(socket, () => controlFrame())
    connections.set(ws, connection)
    ws.on('close', () => {
      connections.delete(ws)
    })
  }
  return {
    upgrade(request: IncomingMessage, transport: Duplex, head: Buffer) {
      const status = options.status(request)
      if (status || !options.accepting()) {
        rejectTransport(transport, status || 503)
        return
      }
      if (wss.clients.size >= limits.connections && rejecting >= limits.rejecting) {
        rejectTransport(transport)
        return
      }
      wss.handleUpgrade(request, transport, head, accept)
    },
    connections: () => connections.values(),
    /** Closes every connection, then every socket, and waits for the WebSocket server. */
    async close(code: number) {
      for (const connection of connections.values()) connection.close(code)
      for (const ws of wss.clients) closer.close(ws, code)
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
