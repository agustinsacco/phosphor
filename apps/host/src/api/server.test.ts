import { setTimeout as sleep } from 'node:timers/promises'
import { connect as netConnect } from 'node:net'
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { createServer, request, Server } from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { encodeGrant, type GrantPayload } from '@phosphor/shared/host-grant'
import { HOST_LIMITS, helloProofMessage, parseHostFrame } from '@phosphor/shared/host-protocol'
import { createAuthority } from './authority'
import { API_LIMITS, startApi } from './server'

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing address')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
let api: ReturnType<typeof startApi> | undefined
let port: number
let claims: GrantPayload
let authority: ReturnType<typeof createAuthority>
let control: {
  publicKey: KeyObject
  privateKey: KeyObject
}
let host: typeof control
let logs: string[]
const sockets: WebSocket[] = []
const challenge = 'a'.repeat(64)
beforeEach(async () => {
  port = await freePort()
  control = generateKeyPairSync('ed25519')
  host = generateKeyPairSync('ed25519')
  const now = Math.floor(Date.now() / 1000)
  claims = {
    v: 1,
    iss: 'http://localhost:12345',
    kid: 'test-key',
    sub: randomUUID(),
    sid: randomUUID(),
    hostId: randomUUID(),
    epoch: 1,
    client: { id: randomUUID(), label: 'Test client' },
    caps: [],
    iat: now,
    exp: now + 300,
    jti: randomBytes(8).toString('hex'),
  }
  authority = createAuthority()
  logs = []
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ws of sockets.splice(0)) ws.terminate()
  await stopApi()
  api = undefined
})
function http(path: string, options: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(options.headers))
    const req = request(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers: { 'cache-control': res.headers['cache-control'] ?? '' },
            }),
          ),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}
function stopApi() {
  return api?.stop()
}
function start(
  limits?: Parameters<typeof startApi>[0]['limits'],
  connectionLimits?: Parameters<typeof startApi>[0]['connectionLimits'],
) {
  api = startApi({
    authority,
    limits,
    connectionLimits,
    port,
    origin: claims.iss,
    hostId: claims.hostId,
    hostVersion: 'test',
    key: host.privateKey,
    fetch: async () =>
      Response.json({
        keys: [{ kid: claims.kid, publicKey: control.publicKey.export({ format: 'jwk' }).x }],
      }),
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
  })
}
async function listen() {
  authority.accept({ accepted: true, nextInSec: 30, ownerId: claims.sub, epoch: claims.epoch })
  await vi.waitFor(() => expect(logs.join('\n')).toContain('api.listening'))
}
const mint = (overrides: Partial<GrantPayload> = {}) =>
  encodeGrant({ ...claims, ...overrides }, (bytes) => sign(null, bytes, control.privateKey))
async function connect(path = '/v1/stream', headers?: Record<string, string>) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
  sockets.push(ws)
  ws.on('error', () => {})
  await once(ws, 'open')
  return ws
}
async function auth(overrides: Partial<GrantPayload> = {}) {
  const ws = await connect()
  const answer = once(ws, 'message')
  ws.send(JSON.stringify({ type: 'auth', grant: mint(overrides), challenge }))
  const [bytes] = await answer
  const frame = parseHostFrame(String(bytes))
  if (!frame.ok) throw new Error('Invalid frame')
  return { ws, frame: frame.value }
}
it('starts only after owner and epoch, rejects rebinding, browsers, methods and paths', async () => {
  const bound = vi.spyOn(Server.prototype, 'listen')
  const serverEvents = vi.spyOn(WebSocketServer.prototype, 'on')
  start()
  await expect(fetch(`http://127.0.0.1:${port}/v1/hello?challenge=${challenge}`)).rejects.toThrow()
  authority.accept({ accepted: true, nextInSec: 30, ownerId: claims.sub })
  await expect(fetch(`http://127.0.0.1:${port}/v1/hello?challenge=${challenge}`)).rejects.toThrow()
  await listen()
  expect(bound).toHaveBeenCalledWith(port, '127.0.0.1', expect.any(Function))
  expect(serverEvents).toHaveBeenCalledWith('error', expect.any(Function))
  for (const [path, options, status] of [
    ['/v1/hello', {}, 400],
    ['/v1/hello/extra', {}, 400],
    ['/v1/hello', { headers: { host: 'bee.tailnet.ts.net:65536' } }, 421],
    ['/v1/hello?challenge=BAD', {}, 400],
    [`/v1/hello?challenge=${challenge}&challenge=${challenge}`, {}, 400],
    ['/unknown', {}, 404],
    ['/v1/stream', {}, 404],
    ['/v1/hello', { method: 'POST' }, 405],
    ['/v1/hello', { headers: { host: 'attacker.invalid' } }, 421],
    ['/v1/hello', { headers: { host: 'foo.ts.net.attacker.invalid' } }, 421],
    ['/v1/hello', { headers: { origin: 'https://site.invalid' } }, 403],
  ] satisfies [string, RequestInit, number][]) {
    const response = await http(path, options)
    expect(response.status).toBe(status)
  }
  for (const hostHeader of [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    'bee.tailnet.ts.net',
    `bee.tailnet.ts.net:${port}`,
  ]) {
    const response = await http(`/v1/hello?challenge=${challenge}`, {
      headers: { host: hostHeader },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const value: unknown = await response.json()
    expect(value).toMatchObject({ hello: { hostId: claims.hostId, capabilities: [] } })
    if (
      !value ||
      typeof value !== 'object' ||
      !('proof' in value) ||
      typeof value.proof !== 'string' ||
      !('hello' in value) ||
      !value.hello ||
      typeof value.hello !== 'object' ||
      !('runtimeEpoch' in value.hello) ||
      typeof value.hello.runtimeEpoch !== 'string'
    )
      throw new Error('Invalid hello')
    expect(
      verify(
        null,
        Buffer.from(helloProofMessage(claims.hostId, value.hello.runtimeEpoch, challenge)),
        host.publicKey,
        Buffer.from(value.proof, 'base64url'),
      ),
    ).toBe(true)
    expect(logs.join('\n')).not.toContain(value.proof)
    expect(logs.join('\n')).not.toContain(hostHeader)
  }
  expect(logs.join('\n')).not.toContain(challenge)
})
it('rejects upgrades on wrong path, origin, host or method', async () => {
  start()
  await listen()
  for (const [path, headers, expected] of [
    ['/other', {}, 404],
    ['/v1/stream?extra=1', {}, 404],
    ['/v1/stream', { host: 'bad.invalid' }, 421],
    ['/v1/stream', { origin: 'https://site.invalid' }, 403],
  ] satisfies [string, Record<string, string>, number][]) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
    sockets.push(ws)
    ws.on('error', () => {})
    const [, _response] = await once(ws, 'unexpected-response')
    expect(_response.statusCode).toBe(expected)
    _response.resume()
    ws.terminate()
  }
})
it('bounds hello requests at ten per process per second', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    start()
    await listen()
    for (let i = 0; i <= API_LIMITS.helloPerSecond; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/hello?challenge=${challenge}`)
      expect(response.status).toBe(i < API_LIMITS.helloPerSecond ? 200 : 429)
    }
    clock.mockReturnValue(2000)
    expect((await fetch(`http://127.0.0.1:${port}/v1/hello?challenge=${challenge}`)).status).toBe(
      200,
    )
  } finally {
    clock.mockRestore()
  }
})
it('caps process sockets at 64 and client sockets at four', async () => {
  start()
  await listen()
  for (let i = 0; i < HOST_LIMITS.connectionsPerClient; i++)
    expect((await auth()).frame.type).toBe('ready')
  const extra = await connect()
  const closed = once(extra, 'close')
  extra.send(JSON.stringify({ type: 'auth', grant: mint(), challenge }))
  expect(
    (
      await Promise.race([
        closed,
        sleep(200).then(() => {
          throw new Error('Client cap not enforced')
        }),
      ])
    )[0],
  ).toBe(4429)
  for (const ws of sockets.splice(0)) {
    if (ws.readyState !== WebSocket.CLOSED) {
      const closed = once(ws, 'close')
      ws.terminate()
      await closed
    }
  }
  for (let i = 0; i < API_LIMITS.connections; i++) await connect()
  expect(sockets.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true)
  const over = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`)
  over.on('error', () => {})
  sockets.push(over)
  expect(
    (
      await Promise.race([
        once(over, 'close'),
        sleep(200).then(() => {
          throw new Error('Process cap not enforced')
        }),
      ])
    )[0],
  ).toBe(4429)
  expect(sockets[0]?.readyState).toBe(WebSocket.OPEN)
})
it('accepts exactly maxPayload bytes, closes one byte over with 1009 and keeps serving', async () => {
  start()
  await listen()
  const { ws } = await auth()
  const text = JSON.stringify({ type: 'ping', at: 1 }).padEnd(HOST_LIMITS.inboundFrameBytes, ' ')
  const pong = once(ws, 'message')
  ws.send(text)
  expect(String((await pong)[0])).toBe(JSON.stringify({ type: 'pong', at: 1 }))
  const closed = once(ws, 'close')
  ws.send(text + ' ')
  expect((await closed)[0]).toBe(1009)
  expect((await auth()).frame.type).toBe('ready')
  expect(logs.join('\n')).toContain('"code":1006')
})
it('rejects binary frames and closes sockets 1001 during drain', async () => {
  start()
  await listen()
  const { ws } = await auth()
  const closed = once(ws, 'close')
  ws.send(Buffer.from('binary'))
  expect((await closed)[0]).toBe(4400)
  const next = await auth()
  const stopped = once(next.ws, 'close')
  await stopApi()
  api = undefined
  expect((await stopped)[0]).toBe(1001)
})
it('logs a busy port and retries without throwing or exposing headers', async () => {
  const occupied = createServer()
  occupied.listen(port, '127.0.0.1')
  await once(occupied, 'listening')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    start()
    authority.accept({ accepted: true, nextInSec: 30, ownerId: claims.sub, epoch: 1 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(logs.join('\n')).toContain('api.unavailable')
    for (let i = 0; i < 3; i++) authority.accept({ accepted: true, nextInSec: 30 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(logs.filter((line) => line.includes('api.unavailable'))).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    await new Promise<void>((resolve) => occupied.close(() => resolve()))
    await vi.advanceTimersByTimeAsync(API_LIMITS.retryMs)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(logs.join('\n')).toContain('api.listening')
  } finally {
    vi.useRealTimers()
    occupied.close()
  }
})

async function stalledPeer() {
  const socket = netConnect(port, '127.0.0.1')
  socket.on('error', () => {})
  await once(socket, 'connect')
  const response = once(socket, 'data')
  socket.write(
    `GET /v1/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
  )
  expect(String((await response)[0])).toContain('101 Switching Protocols')
  return socket
}
it('bounds stalled rejecting peers and counts closing sockets until terminated', async () => {
  start({ connections: 1, rejecting: 1, closeGraceMs: 50 })
  await listen()
  const active = await auth()
  const rejected = await stalledPeer()
  const end = once(rejected, 'end')
  try {
    const excess = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`)
    excess.on('error', () => {})
    sockets.push(excess)
    const [, response] = await Promise.race([
      once(excess, 'unexpected-response'),
      once(excess, 'close').then(() => {
        throw new Error('Expected HTTP rejection')
      }),
    ])
    expect(response.statusCode).toBe(429)
    response.resume()
    excess.terminate()
    const pong = once(active.ws, 'message')
    active.ws.send(JSON.stringify({ type: 'ping', at: 123 }))
    expect(String((await pong)[0])).toBe(JSON.stringify({ type: 'pong', at: 123 }))
    await Promise.race([
      end,
      sleep(200).then(() => {
        throw new Error('Close grace exceeded')
      }),
    ])
    expect(rejected.readableEnded).toBe(true)
    const next = await connect()
    expect((await once(next, 'close'))[0]).toBe(4429)
    active.ws.terminate()
    await vi.waitFor(async () => expect((await auth()).frame.type).toBe('ready'))
  } finally {
    rejected.destroy()
  }
})
it('drains a peer that never answers a close within the grace', async () => {
  start({ closeGraceMs: 50 })
  await listen()
  const stalled = await stalledPeer()
  const ended = once(stalled, 'end')
  try {
    const started = Date.now()
    await Promise.race([
      stopApi(),
      sleep(200).then(() => {
        throw new Error('Drain grace exceeded')
      }),
    ])
    api = undefined
    expect(Date.now() - started).toBeLessThan(200)
    await ended
  } finally {
    stalled.destroy()
  }
})
it('uses control pings without treating automatic pongs as client activity', async () => {
  start(undefined, { pingIntervalMs: 10, idleCloseMs: 100 })
  await listen()
  const { ws } = await auth()
  const messages: string[] = []
  let pings = 0
  ws.on('message', (data) => messages.push(data.toString()))
  ws.on('ping', () => {
    pings++
  })
  const closed = once(ws, 'close')
  expect(
    (
      await Promise.race([
        closed,
        sleep(300).then(() => {
          throw new Error('Automatic pongs must not reset idle')
        }),
      ])
    )[0],
  ).toBe(4401)
  expect(pings).toBeGreaterThan(0)
  expect(messages).toEqual([])
  const active = await auth()
  const ping = once(active.ws, 'ping')
  await ping
  const response = once(active.ws, 'message')
  active.ws.send(JSON.stringify({ type: 'ping', at: 789 }))
  expect(String((await response)[0])).toBe(JSON.stringify({ type: 'pong', at: 789 }))
  expect(active.ws.readyState).toBe(WebSocket.OPEN)
})

it('builds a self-contained CLI and completes an authenticated WebSocket round trip', async () => {
  const { spawn, spawnSync } = await import('node:child_process')
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const { createIdentityStore, identityDirectory } = await import('../control/identity')
  const root = await mkdtemp(join(tmpdir(), 'host-api-bundle-'))
  const configPath = join(root, 'conf', 'config.json')
  const controlServer = createServer((req, res) => {
    req.resume()
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/v1/grant-keys') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          keys: [{ kid: claims.kid, publicKey: control.publicKey.export({ format: 'jwk' }).x }],
        }),
      )
    } else
      res.end(
        JSON.stringify({ accepted: true, nextInSec: 30, ownerId: claims.sub, epoch: claims.epoch }),
      )
  })
  controlServer.listen(0, '127.0.0.1')
  await once(controlServer, 'listening')
  const address = controlServer.address()
  if (!address || typeof address === 'string') throw new Error('Missing control address')
  const origin = `http://127.0.0.1:${address.port}`
  let child: ReturnType<typeof spawn> | undefined
  try {
    await mkdir(join(root, 'conf'), { mode: 0o700 })
    await mkdir(join(root, 'repo'))
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        pi: { executable: '/missing/pi' },
        repositories: [join(root, 'repo')],
        control: { url: origin },
        api: { port },
      }),
      { mode: 0o600 },
    )
    await createIdentityStore(identityDirectory(configPath), process.getuid?.()).save(
      {
        version: 1,
        hostId: claims.hostId,
        label: 'Test Host',
        ownerLogin: 'tester',
        controlUrl: origin,
        savedAt: new Date().toISOString(),
      },
      host.privateKey,
    )
    const output = join(root, 'bundle')
    const built = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, '../../scripts/build.mjs'), '--out', output],
      { encoding: 'utf8' },
    )
    expect(built.status).toBe(0)
    child = spawn(process.execPath, [join(output, 'phosphor.mjs'), 'run', '--config', configPath], {
      env: {
        HOME: root,
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_STATE_HOME: join(root, 'state'),
        PI_CODING_AGENT_SESSION_DIR: join(root, 'sessions'),
        PATH: '/usr/bin:/bin',
      },
      stdio: 'ignore',
    })
    const exited = once(child, 'exit')
    await vi.waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/hello?challenge=${challenge}`)
      expect(response.status).toBe(200)
    })
    const { ws, frame } = await auth({ iss: origin })
    expect(frame.type).toBe('ready')
    const pong = once(ws, 'message')
    ws.send(JSON.stringify({ type: 'ping', at: 12 }))
    expect(String((await pong)[0])).toBe(JSON.stringify({ type: 'pong', at: 12 }))
    const stopped = once(ws, 'close')
    child.kill('SIGTERM')
    expect((await exited)[0]).toBe(0)
    expect((await stopped)[0]).toBe(1001)
  } finally {
    if (child && child.exitCode === null) {
      const ended = once(child, 'exit')
      child.kill('SIGKILL')
      await ended
    }
    await new Promise<void>((resolve) => controlServer.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

it('counts a closing admitted socket until its grace ends', async () => {
  start({ connections: 1, rejecting: 1, closeGraceMs: 50 }, { authTimeoutMs: 10 })
  await listen()
  const stalled = await stalledPeer()
  const ended = once(stalled, 'end')
  try {
    await once(stalled, 'data')
    const excess = await connect()
    expect((await once(excess, 'close'))[0]).toBe(4429)
    await Promise.race([
      ended,
      sleep(200).then(() => {
        throw new Error('Close grace exceeded')
      }),
    ])
    expect((await auth()).frame.type).toBe('ready')
  } finally {
    stalled.destroy()
  }
})

function rawClosed(socket: ReturnType<typeof netConnect>) {
  return new Promise<void>((resolve) => socket.once('close', () => resolve()))
}
async function rawPeer() {
  const socket = netConnect(port, '127.0.0.1')
  socket.on('error', () => {})
  await once(socket, 'connect')
  return socket
}
it('bounds raw TCP sockets before HTTP or upgrade parsing', async () => {
  start({ rawSockets: 1 })
  await listen()
  const existing = await rawPeer()
  try {
    const excess = await rawPeer()
    const closed = once(excess, 'close')
    const response = String(
      (
        await Promise.race([
          once(excess, 'data'),
          sleep(200).then(() => {
            throw new Error('Raw socket cap not enforced')
          }),
        ])
      )[0],
    )
    expect(response).toContain('HTTP/1.1 429 Too Many Requests')
    await closed
    expect(existing.destroyed).toBe(false)
  } finally {
    existing.destroy()
  }
})
it('times out an idle raw socket and drains idle and half-sent requests', async () => {
  start({
    headersTimeout: 50,
    requestTimeout: 50,
    connectionsCheckingInterval: 10,
    closeGraceMs: 50,
  })
  await listen()
  const idle = await rawPeer()
  idle.resume()
  try {
    await Promise.race([
      rawClosed(idle),
      sleep(300).then(() => {
        throw new Error('Headers timeout did not close idle socket')
      }),
    ])
    expect(idle.destroyed).toBe(true)
  } finally {
    idle.destroy()
  }
  await stopApi()
  api = undefined
  logs = []
  start({ closeGraceMs: 50 })
  await listen()
  const quiet = await rawPeer()
  const partial = await rawPeer()
  quiet.resume()
  partial.resume()
  partial.write('GET /v1/hello HTTP/1.1\r\n')
  const closed = Promise.all([rawClosed(quiet), rawClosed(partial)])
  try {
    const began = Date.now()
    await Promise.race([
      stopApi(),
      sleep(200).then(() => {
        throw new Error('Raw drain grace exceeded')
      }),
    ])
    api = undefined
    expect(Date.now() - began).toBeLessThan(200)
    await closed
  } finally {
    quiet.destroy()
    partial.destroy()
  }
})
