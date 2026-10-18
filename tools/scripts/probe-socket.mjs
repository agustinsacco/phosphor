import { WebSocketServer } from 'ws'
import { acceptsProbeToken, allowsProbeRequest } from './probe-http.mjs'

export function createProbeSockets() {
  return new WebSocketServer({
    noServer: true,
    maxPayload: 64,
    perMessageDeflate: false,
    handleProtocols: () => 'phosphor-probe',
  })
}

function startProbeSession(state, ws) {
  let sequence = 0
  let messages = 0
  ws.on('error', () => ws.terminate())
  ws.send(JSON.stringify({ type: 'ready', version: 1 }))
  const ticker = setInterval(() => {
    if (Date.now() >= state.expiresAt) return ws.terminate()
    if (ws.bufferedAmount > 4096) return ws.terminate()
    ws.send(JSON.stringify({ type: 'tick', sequence: ++sequence }))
  }, 250)
  ws.on('close', () => clearInterval(ticker))
  ws.on('message', (data, binary) => {
    if (Date.now() >= state.expiresAt || binary || ++messages > 32 || data.toString() !== 'ping')
      return ws.close(1008, 'Probe messages only')
    ws.send(JSON.stringify({ type: 'pong' }))
  })
}

export function handleProbeUpgrade(state, req, socket, head) {
  const protocols = String(req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map((p) => p.trim())
  if (
    req.url !== '/probe' ||
    !allowsProbeRequest(state, req) ||
    state.sockets.clients.size >= 8 ||
    protocols.length !== 2 ||
    protocols[0] !== 'phosphor-probe' ||
    !acceptsProbeToken(state, protocols[1])
  ) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () =>
      socket.destroy(),
    )
    return
  }
  state.sockets.handleUpgrade(req, socket, head, (ws) => startProbeSession(state, ws))
}
