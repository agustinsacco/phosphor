import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import {
  LOCAL_DAEMON_CONFIG_ENV,
  LOCAL_DAEMON_SOCKET_ENV,
  fetchSocketHello,
  localDaemonLocation,
  localSocketPath,
  openLocalSocket,
  readLocalIdentity,
} from './transport'

const HOME = '/Users/someone'
const MACHINE = '6f1c3a52-7d1e-4c9b-8a55-0b1e2c3d4e5f'
const KEY = 'A'.repeat(43)
const uid = process.getuid?.()
const roots = {
  on: true as const,
  roots: { configDir: '/svc/config/phosphor-host', stateDir: '/svc/state/phosphor-host' },
} as Parameters<typeof localDaemonLocation>[0]['roots']
const dev = {
  [LOCAL_DAEMON_SOCKET_ENV]: '/tmp/m2a/s.sock',
  [LOCAL_DAEMON_CONFIG_ENV]: '/tmp/m2a/c',
}

describe('localDaemonLocation', () => {
  it('keeps an unpackaged build away from any service without both variables', () => {
    for (const env of [
      {},
      { PHOSPHOR_TEST_USER_DATA: '/tmp/m2a/user-data' },
      { [LOCAL_DAEMON_SOCKET_ENV]: '/tmp/m2a/s.sock' },
      { [LOCAL_DAEMON_CONFIG_ENV]: '/tmp/m2a/c' },
    ])
      expect(localDaemonLocation({ isPackaged: false, env, home: HOME, roots }).on).toBe(false)
  })

  it('honours the variables only when unpackaged, and then ignores the install roots', () => {
    expect(localDaemonLocation({ isPackaged: false, env: dev, home: HOME, roots })).toEqual({
      on: true,
      location: { kind: 'dev', socket: '/tmp/m2a/s.sock', configDir: '/tmp/m2a/c' },
    })
    expect(localDaemonLocation({ isPackaged: true, env: dev, home: HOME, roots })).toEqual({
      on: true,
      location: {
        kind: 'service',
        configDir: '/svc/config/phosphor-host',
        stateDir: '/svc/state/phosphor-host',
      },
    })
    const off = { on: false as const, reason: 'Windows' }
    expect(localDaemonLocation({ isPackaged: true, env: dev, home: HOME, roots: off })).toEqual(off)
  })

  it.each([
    ['relative', 'm2a/s.sock'],
    ['unnormalized', '/tmp/../tmp/m2a/s.sock'],
    ['the root', '/'],
    ['the real home', HOME],
    ['an ancestor of home', '/Users'],
    ['in ~/.config', `${HOME}/.config/phosphor-host`],
    ['in ~/.local', `${HOME}/.local/state/phosphor-host/run/phosphor.sock`],
    ['in ~/Library', `${HOME}/Library/x.sock`],
    ['in ~/.pi', `${HOME}/.pi/agent/x`],
    ['in ~/.claude', `${HOME}/.claude/x`],
    ['longer than a socket path holds', `/tmp/${'x'.repeat(100)}.sock`],
  ])('refuses a variable that is %s', (name, value) => {
    const names = name.startsWith('longer')
      ? [LOCAL_DAEMON_SOCKET_ENV]
      : [LOCAL_DAEMON_SOCKET_ENV, LOCAL_DAEMON_CONFIG_ENV]
    for (const variable of names) {
      const env = { ...dev, [variable]: value }
      expect(localDaemonLocation({ isPackaged: false, env, home: HOME, roots }).on).toBe(false)
    }
  })
})

describe('daemon sidecars', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'm2a-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const identity = {
    version: 1,
    machineId: MACHINE,
    createdAt: '2026-11-23T00:00:00Z',
    publicKey: KEY,
  }
  const write = (name: string, value: unknown, mode = 0o600) => {
    writeFileSync(join(dir, name), JSON.stringify(value), { mode })
    chmodSync(join(dir, name), mode)
  }

  it('reads the identity only from a private regular file this user owns', () => {
    expect(readLocalIdentity(dir, uid)).toBeNull()
    write(HOST_SIDECARS.localIdentity, identity)
    expect(readLocalIdentity(dir, uid)).toEqual(identity)
    expect(readLocalIdentity(dir, (uid ?? 0) + 1)).toBeNull()
    chmodSync(join(dir, HOST_SIDECARS.localIdentity), 0o644)
    expect(readLocalIdentity(dir, uid)).toBeNull()
    write(HOST_SIDECARS.localIdentity, { ...identity, machineId: 'nope' })
    expect(readLocalIdentity(dir, uid)).toBeNull()
  })

  it('refuses a symlinked identity file', () => {
    mkdirSync(join(dir, 'real'))
    writeFileSync(join(dir, 'real/id.json'), JSON.stringify(identity), { mode: 0o600 })
    symlinkSync(join(dir, 'real/id.json'), join(dir, HOST_SIDECARS.localIdentity))
    expect(readLocalIdentity(dir, uid)).toBeNull()
  })

  it('dials the socket local.json names, only for the expected machine', () => {
    const service = { kind: 'service' as const, configDir: dir, stateDir: dir }
    expect(localSocketPath(service, MACHINE, uid)).toBeNull()
    const run = {
      version: 1,
      pid: 42,
      hostVersion: '0.2.90',
      machineId: MACHINE,
      socket: '/tmp/m2a/run/phosphor.sock',
      startedAt: 1,
      localReadyAt: 2,
    }
    write(HOST_SIDECARS.localRun, run)
    expect(localSocketPath(service, MACHINE, uid)).toBe('/tmp/m2a/run/phosphor.sock')
    expect(localSocketPath(service, '00000000-0000-4000-8000-000000000000', uid)).toBeNull()
    expect(
      localSocketPath({ kind: 'dev', socket: '/tmp/x.sock', configDir: dir }, MACHINE, uid),
    ).toBe('/tmp/x.sock')
  })
})

describe('the socket transport', () => {
  let dir: string
  let path: string
  let server: Server
  let hello: (url: string) => { status: number; body: string }
  const upgrades: IncomingHttpHeaders[] = []
  let wss: WebSocketServer
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'm2a-'))
    path = join(dir, 's.sock')
    hello = () => ({
      status: 200,
      body: JSON.stringify({ hello: { hostId: MACHINE }, proof: 'p', nonce: 'a'.repeat(64) }),
    })
    server = createServer((request, response) => {
      const answer = hello(request.url ?? '')
      response.writeHead(answer.status).end(answer.body)
    })
    wss = new WebSocketServer({ server })
    wss.on('connection', (ws, request) => {
      upgrades.push(request.headers)
      ws.on('message', (data, binary) => {
        const text = String(data)
        if (text === 'binary') ws.send(Buffer.from('x'), { binary: true })
        else if (text === 'huge') ws.send('x'.repeat(HOST_LIMITS.outboundFrameBytes + 1))
        else if (text === 'leave') ws.close(1001, 'Lanes started')
        else ws.send(binary ? 'binary-in' : `echo:${text}`)
      })
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
  })
  afterEach(async () => {
    for (const client of wss.clients) client.terminate()
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())))
    rmSync(dir, { recursive: true, force: true })
  })

  it('fetches the hello with the challenge and returns its host id and nonce', async () => {
    let asked = ''
    hello = (url) => {
      asked = url
      return {
        status: 200,
        body: JSON.stringify({ hello: { hostId: MACHINE }, proof: 'p', nonce: 'b'.repeat(64) }),
      }
    }
    await expect(fetchSocketHello(path, 'c'.repeat(64))).resolves.toEqual({
      hostId: MACHINE,
      nonce: 'b'.repeat(64),
    })
    expect(asked).toBe(`/v1/hello?challenge=${'c'.repeat(64)}`)
  })

  it.each([
    [{ status: 429, body: '' }, 'too-many-requests'],
    [{ status: 500, body: '{}' }, 'offline'],
    [{ status: 200, body: 'not json' }, 'offline'],
    [
      { status: 200, body: JSON.stringify({ hello: { hostId: MACHINE }, nonce: 'short' }) },
      'offline',
    ],
  ])('a refused or malformed hello is an error (%j)', async (answer, message) => {
    hello = () => answer
    await expect(fetchSocketHello(path, 'c'.repeat(64))).rejects.toThrow(message)
  })

  it('a missing socket is offline', async () => {
    await expect(fetchSocketHello(join(dir, 'none.sock'), 'c'.repeat(64))).rejects.toThrow(
      'offline',
    )
    await expect(openLocalSocket(join(dir, 'none.sock'))).rejects.toThrow('offline')
  })

  it('opens the stream over ws+unix with no Origin header and passes text both ways', async () => {
    const socket = await openLocalSocket(path)
    const got: string[] = []
    socket.onMessage((text) => got.push(text))
    expect(socket.isOpen()).toBe(true)
    socket.send('hi')
    await expect.poll(() => got).toEqual(['echo:hi'])
    expect(upgrades.at(-1)?.origin).toBeUndefined()
    expect(socket.bufferedBytes()).toBe(0)
    const closed = new Promise<number>((resolve) => socket.onClose((code) => resolve(code)))
    socket.close(4000, 'é'.repeat(200))
    await expect(closed).resolves.toBe(4000)
  })

  it('reports the service closing with 1001, for the connection to reconnect', async () => {
    const socket = await openLocalSocket(path)
    const closed = new Promise<number>((resolve) => socket.onClose((code) => resolve(code)))
    socket.send('leave')
    await expect(closed).resolves.toBe(1001)
    expect(socket.isOpen()).toBe(false)
  })

  it.each(['binary', 'huge'])('closes with 4400 on a %s frame', async (kind) => {
    const socket = await openLocalSocket(path)
    const got: string[] = []
    socket.onMessage((text) => got.push(text))
    const closed = new Promise<number>((resolve) => socket.onClose((code) => resolve(code)))
    socket.send(kind)
    // `ws` itself drops an oversized frame (maxPayload) before our check sees it.
    const code = await closed
    if (kind === 'binary') expect(code).toBe(4400)
    else expect([1006, 1009]).toContain(code)
    expect(got).toEqual([])
  })

  it('maps a close code the client may not send to a normal close', async () => {
    const socket = await openLocalSocket(path)
    const closed = new Promise<number>((resolve) => socket.onClose((code) => resolve(code)))
    socket.close(1001, '')
    await expect(closed).resolves.toBe(1000)
  })
})
