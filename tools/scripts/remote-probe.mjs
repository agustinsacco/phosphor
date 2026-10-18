import { createServer } from 'node:http'
import { URL } from 'node:url'
import { handleProbeHttp } from './probe-http.mjs'
import { createProbeSockets, handleProbeUpgrade } from './probe-socket.mjs'

function validateProbeOptions(origin, token, ttlMs) {
  if (new URL(origin).origin !== origin || !origin.startsWith('https://'))
    throw new Error('An exact HTTPS origin is required')
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
    throw new Error('A random 32-byte hex token is required')
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000)
    throw new Error('Lifetime must be between 1 and 300000 ms')
}

function closeProbe(state) {
  if (!state.stopped)
    state.stopped = new Promise((resolve) => {
      clearTimeout(state.expiry)
      for (const ws of state.sockets.clients) ws.terminate()
      state.sockets.close()
      state.server.close(resolve)
      state.server.closeAllConnections()
    })
  return state.stopped
}

/** Diagnostic fixture only: no pi, files, commands, cookies or persistent state. */
export async function createProbe({ origin, token, port = 0, ttlMs = 300_000 }) {
  validateProbeOptions(origin, token, ttlMs)
  const state = {
    origin,
    token,
    expiresAt: Date.now() + ttlMs,
    server: undefined,
    sockets: createProbeSockets(),
    stopped: undefined,
    expiry: undefined,
  }
  const server = createServer((req, res) => handleProbeHttp(state, req, res))
  state.server = server
  server.maxConnections = 32
  server.headersTimeout = 5000
  server.requestTimeout = 5000
  server.setTimeout(5000, (socket) => socket.destroy())
  server.on('upgrade', (req, socket, head) => handleProbeUpgrade(state, req, socket, head))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const close = () => closeProbe(state)
  state.expiry = setTimeout(close, ttlMs)
  return {
    url: `http://127.0.0.1:${server.address().port}/probe`,
    expiresAt: state.expiresAt,
    close,
  }
}
