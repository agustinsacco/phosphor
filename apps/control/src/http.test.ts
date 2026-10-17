import { afterEach, expect, it } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { connect } from 'node:net'
import { createApp } from './app'
import { dependencies, token } from './test-support'
import { clientIp, refuseBody } from './http'
import { randomBytes } from 'node:crypto'
import { parseConfig } from './config'

let server: ServerType | undefined
let port: number
const sockets = new Set<ReturnType<typeof connect>>()
afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  if (server)
    await new Promise<void>((resolve, reject) => server?.close((e) => (e ? reject(e) : resolve())))
  server = undefined
})
async function start(deps: ReturnType<typeof dependencies>) {
  port = await new Promise<number>((resolve) => {
    server = serve({ fetch: createApp(deps).fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
      resolve(info.port),
    )
  })
}
function rawRequest(method: string, headers = '', body = '', path = '/api/v1/health') {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    sockets.add(socket)
    let data = ''
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      data += chunk.toString()
    })
    socket.on('end', () => resolve(data))
    socket.on('connect', () =>
      socket.end(
        `${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${headers}\r\n${body}`,
      ),
    )
  })
}
it('refuses real-socket GET bodies before handlers or upstream calls', async () => {
  const deps = dependencies()
  await start(deps)
  for (const [headers, body] of [
    ['Content-Length: 20480\r\nContent-Type: application/json\r\n', 'x'.repeat(20480)],
    ['Content-Length: 3\r\nContent-Type: text/plain\r\n', 'abc'],
    ['Transfer-Encoding: chunked\r\n', '3\r\nabc\r\n0\r\n\r\n'],
  ]) {
    expect(await rawRequest('GET', headers, body)).toContain('HTTP/1.1 400')
    expect(await rawRequest('GET', headers, body, '/api/v1/me')).toContain('HTTP/1.1 400')
  }
  for (const method of ['HEAD', 'DELETE']) {
    expect(await rawRequest(method, 'Content-Length: 3\r\n', 'abc')).toContain('HTTP/1.1 400')
    expect(await rawRequest(method, 'Transfer-Encoding: chunked\r\n', '0\r\n\r\n')).toContain(
      'HTTP/1.1 400',
    )
  }
  expect(await rawRequest('GET')).toContain('HTTP/1.1 200')
  expect(await rawRequest('GET', 'Content-Length: 0\r\n')).toContain('HTTP/1.1 200')
  expect(deps.supabase.getUser).not.toHaveBeenCalled()
  expect(deps.supabase.rpc).not.toHaveBeenCalled()
})
it('checks Fetch framing when no Node binding exists', () => {
  for (const method of ['GET', 'HEAD', 'DELETE']) {
    for (const headers of [
      new Headers({ 'content-length': '1' }),
      new Headers({ 'transfer-encoding': 'chunked' }),
    ])
      expect(() =>
        refuseBody(new Request('http://localhost/api/v1/health', { method, headers }), undefined),
      ).toThrow('bad-request')
    expect(() =>
      refuseBody(
        new Request('http://localhost/api/v1/health', {
          method,
          headers: { 'content-length': '0' },
        }),
        undefined,
      ),
    ).not.toThrow()
  }
})
it('uses the real socket address, not untrusted proxy headers, for user limits', async () => {
  const deps = dependencies()
  await start(deps)
  for (let i = 0; i <= 30; i++) {
    const response = await rawRequest(
      'GET',
      `Authorization: Bearer ${token(deps.clock() / 1000 + 100 + i)}\r\ncf-connecting-ip: 192.0.2.${i + 1}\r\n`,
      '',
      '/api/v1/me',
    )
    expect(response).toContain(`HTTP/1.1 ${i === 30 ? 429 : 200}`)
  }
  expect(deps.supabase.getUser).toHaveBeenCalledTimes(30)
  expect(deps.limits.consume('user-verify:127.0.0.1', 30, 60_000)).toBe(false)
})

it('trusts an IP only with Cloudflare mode and the correct edge secret', () => {
  const secret = randomBytes(32).toString('base64url')
  const config = parseConfig({ CONTROL_TRUST_PROXY: 'cloudflare', CONTROL_EDGE_SECRET: secret })
  const request = new Request('http://localhost', {
    headers: { 'cf-connecting-ip': '192.0.2.1', 'x-phosphor-edge': secret },
  })
  expect(clientIp(request, '10.42.0.1', config)).toBe('192.0.2.1')
  expect(clientIp(request, '10.42.0.1', { ...config, trustProxy: 'none' })).toBe('10.42.0.1')
  expect(clientIp(request, '10.42.0.1', parseConfig({ CONTROL_EDGE_SECRET: secret }))).toBe(
    '10.42.0.1',
  )
  request.headers.set('cf-connecting-ip', '2001:db8::1')
  expect(clientIp(request, '10.42.0.1', config)).toBe('2001:db8::1')
  for (const forwarded of ['invalid', '192.0.2.1, 192.0.2.2', '']) {
    request.headers.set('cf-connecting-ip', forwarded)
    expect(clientIp(request, '10.42.0.1', config)).toBe('10.42.0.1')
  }
  request.headers.set('cf-connecting-ip', '192.0.2.1')
  for (const edge of [
    randomBytes(32).toString('base64url'),
    randomBytes(33).toString('base64url'),
    '',
  ]) {
    request.headers.set('x-phosphor-edge', edge)
    expect(clientIp(request, '10.42.0.1', config)).toBe('10.42.0.1')
  }
  request.headers.delete('x-phosphor-edge')
  expect(clientIp(request, '10.42.0.1', config)).toBe('10.42.0.1')
})

function edgeConfig() {
  const secret = randomBytes(32).toString('base64url')
  return {
    secret,
    config: parseConfig({
      SUPABASE_SECRET_KEY: randomBytes(32).toString('hex'),
      CONTROL_TRUST_PROXY: 'cloudflare',
      CONTROL_EDGE_SECRET: secret,
    }),
  }
}
it('keys trusted-edge IPv6 addresses by /64, so rotating /128s share one bucket', () => {
  const { secret, config } = edgeConfig()
  const key = (forwarded: string) =>
    clientIp(
      new Request('http://localhost', {
        headers: { 'cf-connecting-ip': forwarded, 'x-phosphor-edge': secret },
      }),
      '10.42.0.1',
      config,
    )
  const network = key('2001:db8:1:2::1')
  for (const forwarded of [
    '2001:db8:1:2::2',
    '2001:DB8:1:2:FFFF:FFFF:FFFF:FFFF',
    '2001:0db8:0001:0002:0000:0000:0000:0001',
    '2001:db8:1:2:a:b:c:d',
  ])
    expect(key(forwarded)).toBe(network)
  expect(key('2001:db8:1:3::1')).not.toBe(network)
  expect(key('2001:db9:1:2::1')).not.toBe(network)
  expect(key('::ffff:192.0.2.1')).toBe('192.0.2.1')
  expect(key('192.0.2.1')).toBe('192.0.2.1')
})
it('normalizes the socket address too, and untrusted headers never choose the bucket', () => {
  const { config } = edgeConfig()
  const key = (forwarded: string, edge: string, socket: string) =>
    clientIp(
      new Request('http://localhost', {
        headers: { 'cf-connecting-ip': forwarded, 'x-phosphor-edge': edge },
      }),
      socket,
      config,
    )
  const wrong = randomBytes(32).toString('base64url')
  const socket = key('192.0.2.1', wrong, '2001:db8:9:9::5')
  for (const [forwarded, address] of [
    ['192.0.2.2', '2001:db8:9:9::6'],
    ['2001:db8:1:2::1', '2001:DB8:9:9:0:0:0:7'],
    ['2001:db8:1:3::1', '2001:0db8:0009:0009::8'],
  ])
    expect(key(String(forwarded), wrong, String(address))).toBe(socket)
  expect(key('192.0.2.1', wrong, '2001:db8:9:a::5')).not.toBe(socket)
  expect(key('192.0.2.1', wrong, '::ffff:10.42.0.1')).toBe('10.42.0.1')
  expect(clientIp(new Request('http://localhost'), '2001:db8:9:9::1', config)).toBe(socket)
})
it('spends one enrollment-create budget for a /64 whose trusted-edge /128 rotates', async () => {
  const deps = dependencies()
  const { secret, config } = edgeConfig()
  deps.config = config
  const app = createApp(deps)
  const enroll = (ip: string) =>
    app.request('/api/v1/enrollments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': ip,
        'x-phosphor-edge': secret,
      },
      body: '{}',
    })
  for (let i = 1; i <= 10; i++) expect((await enroll(`2001:db8:5:6::${i}`)).status).toBe(400)
  expect((await enroll('2001:db8:5:6:ffff::1')).status).toBe(429)
  expect((await enroll('2001:db8:5:7::1')).status).toBe(400)
})
