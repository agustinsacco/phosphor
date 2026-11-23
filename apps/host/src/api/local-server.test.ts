import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_LIMITS } from '@phosphor/shared/host-local'
import type { HostFrame } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { createLaneCommands, type LaneCommandPorts } from '../lanes/commands'
import type { LaneService } from '../lanes/service'
import { localCredential, localKeyPair } from '../owner/__fixtures__/local-identity'
import { createOwnerAdapter } from '../owner/adapter'
import { socketGet, socketHello, socketStream } from './__fixtures__/local-client'
import { createLaneAdapter } from './lanes'
import { chooseSocketPath, LocalSocketRefused, startLocalServer } from './local-server'
import { hostLinks } from './server'

const uid = process.getuid?.()
const machineId = randomUUID()
const owner = localKeyPair()
const ownerClient = { id: randomUUID(), label: 'Desktop' }
const folders: string[] = []
const servers: { stop(): Promise<void> }[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

/** A short temporary root, so its socket path stays well under `sun_path`. */
async function root() {
  const folder = await mkdtemp(join(tmpdir(), 'd3-'))
  folders.push(folder)
  return folder
}

async function start(candidates: readonly string[], overrides: { uid?: number } = {}) {
  const server = await startLocalServer({
    candidates,
    uid: 'uid' in overrides ? overrides.uid : uid,
    hostVersion: '1.0.0',
    auth: {
      machineId,
      key: generateKeyPairSync('ed25519').privateKey,
      ownerClients: () => ({
        version: 1,
        clients: [{ ...ownerClient, publicKey: owner.raw, addedAt: '2026-01-01T00:00:00.000Z' }],
      }),
    },
    links: [
      createOwnerAdapter({
        'machine.local': async () => ({ machineId, hostVersion: '1.0.0', mode: 'local' }),
      }),
    ],
  })
  servers.push(server)
  return server
}

/** Opens a stream and authenticates with a fresh nonce; `kind` picks the credential. */
async function connect(path: string, kind: 'owner' | 'local', client = ownerClient) {
  const { body } = await socketHello(path)
  const nonce = (body as { nonce: string }).nonce
  const stream = socketStream(path)
  await stream.opened
  const token =
    kind === 'owner'
      ? localCredential({ kind, machineId, client, nonce }, owner.privateKey)
      : localCredential({ kind, machineId, nonce })
  stream.send({ type: 'auth', grant: token, challenge: 'c'.repeat(64) })
  await vi.waitFor(() => expect(stream.frames[0]?.type).toBe('ready'))
  return stream
}

/** Leaves a socket file with no listener, as a SIGKILLed daemon does: no close, so no unlink. */
async function crashedListener(path: string) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('up'))`,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const exited = new Promise((resolve) => child.once('exit', resolve))
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve())
    child.once('error', reject)
    child.once('exit', () => reject(new Error('listener exited before binding')))
  })
  child.kill('SIGKILL')
  await exited
}

const frameOf = <T extends HostFrame['type']>(
  frames: HostFrame[],
  type: T,
  match: (f: Extract<HostFrame, { type: T }>) => boolean,
) =>
  frames.find(
    (f): f is Extract<HostFrame, { type: T }> =>
      f.type === type && match(f as Extract<HostFrame, { type: T }>),
  )

describe('the socket path', () => {
  it('accepts 103 UTF-8 bytes and refuses 104, counting bytes not characters', () => {
    const fits = `/${'a'.repeat(LOCAL_LIMITS.socketPathBytes - 1)}`
    expect(chooseSocketPath([fits])).toBe(fits)
    expect(() => chooseSocketPath([`${fits}a`])).toThrow(LocalSocketRefused)
    const wide = `/${'é'.repeat(51)}a` // 104 bytes in 53 characters
    expect(wide.length).toBeLessThan(LOCAL_LIMITS.socketPathBytes)
    expect(() => chooseSocketPath([wide])).toThrow(LocalSocketRefused)
    expect(chooseSocketPath([`${fits}a`, fits])).toBe(fits)
  })

  it('refuses a 104-byte path before creating its folder or binding', async () => {
    const base = await root()
    const prefix = join(base, 'run') + '/'
    const path = prefix + 'p'.repeat(104 - Buffer.byteLength(prefix))
    expect(Buffer.byteLength(path)).toBe(104)
    await expect(start([path])).rejects.toMatchObject({ reason: 'path' })
    expect(existsSync(join(base, 'run'))).toBe(false)
  })

  it('creates its folder 0700 and the socket 0600, and removes the socket on stop', async () => {
    const path = join(await root(), 'run', 'phosphor.sock')
    const server = await start([path])
    expect(lstatSync(join(path, '..')).mode & 0o777).toBe(0o700)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    await server.stop()
    servers.splice(0)
    expect(existsSync(path)).toBe(false)
  })

  it('refuses a foreign folder, as in a shared /tmp, without changing it', async () => {
    const folder = join(await root(), 'phosphor-501')
    await mkdir(folder, { mode: 0o700 })
    // Another user's folder: this process's uid does not own it.
    await expect(start([join(folder, 'a.sock')], { uid: (uid ?? 0) + 1 })).rejects.toMatchObject({
      reason: 'folder',
    })
    await chmod(folder, 0o755)
    await expect(start([join(folder, 'a.sock')])).rejects.toMatchObject({ reason: 'folder' })
    expect(lstatSync(folder).mode & 0o777).toBe(0o755)
    const real = join(await root(), 'real')
    await mkdir(real, { mode: 0o700 })
    const link = join(await root(), 'link')
    await symlink(real, link)
    await expect(start([join(link, 'a.sock')])).rejects.toMatchObject({ reason: 'folder' })
    expect(existsSync(join(folder, 'a.sock'))).toBe(false)
  })

  it('refuses a path a live listener or a plain file holds', async () => {
    const base = await root()
    await mkdir(join(base, 'run'), { mode: 0o700 })
    const file = join(base, 'run', 'file.sock')
    await writeFile(file, '')
    await expect(start([file])).rejects.toMatchObject({ reason: 'occupied' })
    const live = join(base, 'run', 'live.sock')
    const other = createServer()
    await new Promise<void>((resolve) => other.listen(live, resolve))
    try {
      await expect(start([live])).rejects.toMatchObject({ reason: 'occupied' })
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()))
    }
  })

  it('removes a socket a crashed listener left behind, rebinds it and serves hello', async () => {
    const path = join(await root(), 'run', 'phosphor.sock')
    await mkdir(join(path, '..'), { mode: 0o700 })
    await crashedListener(path)
    expect(lstatSync(path).isSocket()).toBe(true)
    const stale = lstatSync(path).ino
    const server = await start([path])
    expect(lstatSync(path).ino).not.toBe(stale)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect((await socketHello(server.path)).status).toBe(200)
  })
})

describe('the socket hello and handshake', () => {
  it('answers hello with a nonce, and refuses Origin, other methods, other routes and a 65th nonce', async () => {
    const { path } = await start([join(await root(), 'run', 'phosphor.sock')])
    const hello = await socketHello(path)
    expect(hello.status).toBe(200)
    expect(hello.body).toMatchObject({
      hello: { hostId: machineId },
      nonce: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    const challenge = `/v1/hello?challenge=${'a'.repeat(64)}`
    expect(
      (await socketGet(path, challenge, { origin: 'https://phosphor-app.saccolabs.com' })).status,
    ).toBe(403)
    expect((await socketGet(path, '/v1/other')).status).toBe(404)
    for (let i = 1; i < LOCAL_LIMITS.noncesOutstanding; i++) await socketHello(path)
    expect((await socketHello(path)).status).toBe(429)
  })

  it('refuses an upgrade with an Origin header and a phosphor-grant token', async () => {
    const { path } = await start([join(await root(), 'run', 'phosphor.sock')])
    const browser = socketStream(path, { origin: 'https://phosphor-app.saccolabs.com' })
    await expect(browser.opened).rejects.toThrow('HTTP 403')
    const stream = socketStream(path)
    await stream.opened
    stream.send({
      type: 'auth',
      grant: `phosphor-grant.${'a'.repeat(40)}.${'b'.repeat(86)}`,
      challenge: 'c'.repeat(64),
    })
    await vi.waitFor(() => expect(stream.closed()).toEqual({ code: 4401 }))
    expect(stream.frames).toEqual([{ type: 'error', code: 4401, message: '4401' }])
  })

  it('in standby serves owner calls only: no lanes, and local callers are refused owner-only calls', async () => {
    const { path } = await start([join(await root(), 'run', 'phosphor.sock')])
    const desktop = await connect(path, 'owner')
    expect(desktop.frames[0]).toMatchObject({
      type: 'ready',
      ownerLocal: true,
      hello: { hostId: machineId },
      capabilities: [],
    })
    desktop.send({ type: 'call', id: 'm', method: 'machine.local' })
    desktop.send({ type: 'subscribe', id: 's', topic: 'lanes' })
    await vi.waitFor(() => expect(desktop.frames).toHaveLength(3))
    // The owner call answers asynchronously, so the refusal may come first.
    expect(desktop.frames.slice(1)).toEqual(
      expect.arrayContaining([
        {
          type: 'result',
          id: 'm',
          ok: true,
          data: { machineId, hostVersion: '1.0.0', mode: 'local' },
        },
        { type: 'subscribe-failed', id: 's', code: 'forbidden' },
      ]),
    )
    const cli = await connect(path, 'local')
    expect(cli.frames[0]).not.toHaveProperty('ownerLocal')
    cli.send({ type: 'call', id: 'i', method: 'owner.index', params: {} })
    await vi.waitFor(() => expect(cli.frames).toHaveLength(2))
    expect(cli.frames[1]).toMatchObject({ id: 'i', ok: false, error: { code: 'forbidden' } })
    desktop.close()
    cli.close()
  })
})

/** A lane service whose commands gate with the Host's real capability table and record what got through. */
function laneService(capabilities: readonly HostCapability[]) {
  const submitted: string[] = []
  const gate = createLaneCommands({} as LaneCommandPorts)
  const service = {
    epoch: 'fedcba9876543210',
    capabilities,
    commands: {
      capabilityFor: gate.capabilityFor,
      submit: async (_client: unknown, frame: { op: { type: string } }) => {
        submitted.push(frame.op.type)
      },
      status: () => {},
    },
    calls: { call: async () => ({ ok: true, data: 'read' }), capabilityFor: () => 'sessions.read' },
    streams: {},
    lanesTopic: {},
    controllerPresence: () => {},
  } as unknown as LaneService
  return { service, submitted }
}

const routine = {
  name: 'Report',
  instructions: 'Report.',
  repositoryId: '0123456789abcdef',
  isolated: false,
  intent: 'report',
  provider: 'fake',
  model: 'fake-model',
  timezone: 'UTC',
  schedule: { kind: 'manual' },
  period: 'none',
  catchUpHours: 0,
  maxRuntimeMinutes: 30,
  enabled: false,
  trusted: false,
}

describe('the socket with lanes', () => {
  it('closes standby connections, then a local caller reads but is forbidden lane.prompt, terminal.create and routine.save', async () => {
    const server = await start([join(await root(), 'run', 'phosphor.sock')])
    const early = await connect(server.path, 'owner')
    const { service, submitted } = laneService([
      'sessions.read',
      'sessions.control',
      'terminal',
      'routines',
      'workspaces.read',
    ])
    const adapter = createLaneAdapter(service)
    server.serveLanes({ ...service, links: hostLinks(), handler: adapter.handler })
    await vi.waitFor(() => expect(early.closed()).toEqual({ code: 1001 }))
    const cli = await connect(server.path, 'local')
    expect(cli.frames[0]).toMatchObject({ capabilities: ['sessions.read', 'workspaces.read'] })
    const ops = [
      { type: 'prompt', message: 'x' },
      { type: 'terminal.create', cols: 80, rows: 24 },
      { type: 'routine.save', routine, expectedRevision: null },
    ]
    const ids = ops.map(() => randomUUID())
    ops.forEach((op, i) =>
      cli.send({
        type: 'command',
        requestId: ids[i],
        ...(op.type === 'prompt' ? { laneId: randomUUID() } : {}),
        op,
      }),
    )
    cli.send({ type: 'call', id: 'read', method: 'lane.list', params: {} })
    await vi.waitFor(() => expect(cli.frames).toHaveLength(5))
    for (const requestId of ids)
      expect(
        frameOf(cli.frames, 'receipt', (f) => f.receipt.requestId === requestId)?.receipt,
      ).toEqual({
        requestId,
        status: 'rejected',
        code: 'forbidden',
      })
    expect(frameOf(cli.frames, 'result', (f) => f.id === 'read')).toEqual({
      type: 'result',
      id: 'read',
      ok: true,
      data: 'read',
    })
    expect(submitted).toEqual([])
    cli.close()
  })

  it('serves the owner through the shared adapter, so a receipt reaches it with no TCP listener, until the lanes stop', async () => {
    const server = await start([join(await root(), 'run', 'phosphor.sock')])
    const { service, submitted } = laneService(['sessions.read', 'sessions.control'])
    const adapter = createLaneAdapter(service)
    const served = server.serveLanes({ ...service, links: hostLinks(), handler: adapter.handler })
    const desktop = await connect(server.path, 'owner')
    const requestId = randomUUID()
    desktop.send({
      type: 'command',
      requestId,
      laneId: randomUUID(),
      op: { type: 'prompt', message: 'x' },
    })
    await vi.waitFor(() => expect(submitted).toEqual(['prompt']))
    adapter.deliver(ownerClient.id, { requestId, status: 'accepted' } as never)
    await vi.waitFor(() =>
      expect(
        frameOf(desktop.frames, 'receipt', (f) => f.receipt.requestId === requestId),
      ).toBeDefined(),
    )
    expect(adapter.isConnected(ownerClient.id)).toBe(true)
    // Teardown stops the lanes before their store closes: the adapter forgets the client at once.
    await served.stop()
    expect(adapter.isConnected(ownerClient.id)).toBe(false)
    await vi.waitFor(() => expect(desktop.closed()).toEqual({ code: 1001 }))
    const after = await connect(server.path, 'owner')
    expect(after.frames[0]).toMatchObject({ capabilities: [] })
    after.close()
  })
})
