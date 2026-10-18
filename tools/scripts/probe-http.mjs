import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'

// HTTP and WebSocket admission share the same exact-origin, lifetime and token checks.
export function acceptsProbeToken(state, value) {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{64}$/.test(value) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(state.token))
  )
}

export function allowsProbeRequest(state, req) {
  return req.headers.origin === state.origin && Date.now() < state.expiresAt
}

function handlePreflight(req, res) {
  const headers = String(req.headers['access-control-request-headers'] || '')
    .toLowerCase()
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  if (
    req.headers['access-control-request-method'] !== 'GET' ||
    headers.some((h) => h !== 'authorization')
  )
    return res.writeHead(403).end()
  res.setHeader('Access-Control-Allow-Methods', 'GET')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization')
  if (req.headers['access-control-request-private-network'] === 'true')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  return res.writeHead(204).end()
}

export function handleProbeHttp(state, req, res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader(
    'Vary',
    'Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network',
  )
  if (req.url !== '/probe' || !allowsProbeRequest(state, req)) return res.writeHead(403).end()
  res.setHeader('Access-Control-Allow-Origin', state.origin)
  if (req.method === 'OPTIONS') return handlePreflight(req, res)
  if (req.method !== 'GET') return res.writeHead(405).end()
  const auth = req.headers.authorization
  if (!acceptsProbeToken(state, auth?.startsWith('Bearer ') ? auth.slice(7) : undefined))
    return res.writeHead(401).end()
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ type: 'probe', version: 1, expiresAt: state.expiresAt }))
}
