import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { acceptsProbeToken, allowsProbeRequest, handleProbeHttp } from './probe-http.mjs'

const origin = 'https://app.example'
const token = 'ab'.repeat(32)
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        }),
    ),
  )
})

async function start() {
  const state = { origin, token, expiresAt: Date.now() + 300_000 }
  const server = createServer((req, res) => handleProbeHttp(state, req, res))
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  return { state, url: `http://127.0.0.1:${address.port}/probe` }
}

it('shares exact origin, strict expiry and fixed-length lowercase token admission', () => {
  const state = { origin, token, expiresAt: Date.now() + 300_000 }
  expect(acceptsProbeToken(state, token)).toBe(true)
  for (const candidate of [undefined, '', token.toUpperCase(), `${token}00`, 'é'.repeat(64)])
    expect(acceptsProbeToken(state, candidate)).toBe(false)
  expect(acceptsProbeToken(state, '00'.repeat(32))).toBe(false)
  expect(allowsProbeRequest(state, { headers: { origin } })).toBe(true)
  expect(allowsProbeRequest(state, { headers: {} })).toBe(false)
  expect(allowsProbeRequest(state, { headers: { origin: `${origin}/` } })).toBe(false)
  state.expiresAt = Date.now()
  expect(allowsProbeRequest(state, { headers: { origin } })).toBe(false)
})

it.each(['', ' Authorization , AUTHORIZATION '])(
  'allows only GET preflight with optional authorization headers: %s',
  async (requestedHeaders) => {
    const { url } = await start()
    const response = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': requestedHeaders,
        'Access-Control-Request-Private-Network': 'true',
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('vary')).toBe(
      'Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network',
    )
    expect(response.headers.get('access-control-allow-origin')).toBe(origin)
    expect(response.headers.get('access-control-allow-methods')).toBe('GET')
    expect(response.headers.get('access-control-allow-headers')).toBe('Authorization')
    expect(response.headers.get('access-control-allow-private-network')).toBe('true')
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
    expect(await response.text()).toBe('')
  },
)

it.each(['false', 'TRUE', ''])('does not grant private-network access for %s', async (value) => {
  const { url } = await start()
  const response = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Private-Network': value,
    },
  })
  expect(response.status).toBe(204)
  expect(response.headers.get('access-control-allow-private-network')).toBeNull()
})

it.each([
  { method: 'POST', headers: 'authorization' },
  { method: 'get', headers: 'authorization' },
  { method: 'GET', headers: 'authorization,x-extra' },
  { method: '', headers: '' },
])('denies preflight method=$method headers=$headers', async (request) => {
  const { url } = await start()
  const response = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': request.method,
      'Access-Control-Request-Headers': request.headers,
      'Access-Control-Request-Private-Network': 'true',
    },
  })
  expect(response.status).toBe(403)
  expect(response.headers.get('access-control-allow-origin')).toBe(origin)
  expect(response.headers.get('access-control-allow-private-network')).toBeNull()
})

it('serves diagnostic GET only after path, origin, method, token and lifetime checks', async () => {
  const { url, state } = await start()
  const headers = { Origin: origin, Authorization: `Bearer ${token}` }
  const response = await fetch(url, { headers })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/json')
  expect(await response.json()).toEqual({ type: 'probe', version: 1, expiresAt: state.expiresAt })
  expect((await fetch(url, { headers: { Origin: origin } })).status).toBe(401)
  expect((await fetch(url, { method: 'POST', headers })).status).toBe(405)
  for (const [path, from] of [
    [url, 'https://other.example'],
    [`${url}?token=${token}`, origin],
    [url.replace('/probe', '/'), origin],
  ] as const) {
    const denied = await fetch(path, { headers: { ...headers, Origin: from } })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('cache-control')).toBe('no-store')
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  }
  state.expiresAt = Date.now()
  expect((await fetch(url, { headers })).status).toBe(403)
})
