import { verify } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { helloProofMessage } from '@phosphor/shared/host-protocol'
import type * as Runtime from '../session/runtime'
import { socketHello, socketStream } from '../api/__fixtures__/local-client'
import { localCredential, writeLocalIdentity } from '../owner/__fixtures__/local-identity'
import { createLocalSocketStarter } from '../owner/socket'
import { runHost } from './run'
import type { LocalDaemon } from './run-local'
import { localRunMachine } from './__fixtures__/run-local'

const hooks = vi.hoisted(() => ({
  machine: null as Omit<Runtime.HostMachine, 'log'> | null,
}))
vi.mock('./doctor', () => ({
  inspectHost: vi.fn(async () => ({ machine: hooks.machine, secrets: [] })),
}))

const folders: string[] = []
afterEach(async () => {
  hooks.machine = null
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

/** A short temporary socket path: never the real state folder or `/tmp/phosphor-<uid>`. */
async function socketPath() {
  const folder = await mkdtemp(join(tmpdir(), 'd3-'))
  folders.push(folder)
  return join(folder, 'run', 'phosphor.sock')
}

type Identity = Awaited<ReturnType<typeof writeLocalIdentity>>

/** Desktop on the socket: a fresh nonce, a signed owner credential, then ready. */
async function ownerConnection(path: string, local: Identity, now: () => number) {
  const { body } = await socketHello(path)
  const stream = socketStream(path)
  await stream.opened
  const nonce = (body as { nonce: string }).nonce
  const grant = localCredential(
    {
      kind: 'owner',
      machineId: local.machineId,
      client: local.ownerClient,
      nonce,
      iat: Math.floor(now() / 1000),
    },
    local.owner.privateKey,
  )
  stream.send({ type: 'auth', grant, challenge: 'c'.repeat(64) })
  await vi.waitFor(() => expect(stream.frames[0]).toMatchObject({ type: 'ready' }))
  return stream
}

/** The result frame for call `id`, once it arrives. */
async function result(stream: ReturnType<typeof socketStream>, id: string) {
  await vi.waitFor(
    () => expect(stream.frames.some((f) => f.type === 'result' && f.id === id)).toBe(true),
    { timeout: 5000 },
  )
  return stream.frames.find((f) => f.type === 'result' && f.id === id)
}

describe('run with the local-mode marker serves the owner socket', () => {
  it('R1: a marker without a control identity serves the socket and writes local.json', async () => {
    const host = await localRunMachine({ enrolled: false, marker: true, heartbeat: 'accepted' })
    try {
      hooks.machine = host.machine
      const local = await writeLocalIdentity(
        dirname(host.control.configPath),
        host.control.context.uid,
      )
      const path = await socketPath()
      const context = host.context()
      const run = runHost({
        ...context,
        startLocalSocket: createLocalSocketStarter(context, { candidates: [path] }),
      })
      await vi.waitFor(
        () => expect(existsSync(join(host.state, HOST_SIDECARS.localRun))).toBe(true),
        {
          timeout: 10_000,
        },
      )
      const runFile: unknown = JSON.parse(
        await readFile(join(host.state, HOST_SIDECARS.localRun), 'utf8'),
      )
      expect(runFile).toMatchObject({
        version: 1,
        machineId: local.machineId,
        socket: path,
        pid: process.pid,
      })
      const answer = await socketHello(path)
      expect(answer.status).toBe(200)
      const body = answer.body as {
        hello: { hostId: string; runtimeEpoch: string }
        proof: string
        nonce: string
      }
      expect(body.hello.hostId).toBe(local.machineId)
      expect(body.nonce).toMatch(/^[0-9a-f]{64}$/)
      expect(
        verify(
          null,
          Buffer.from(
            helloProofMessage(local.machineId, body.hello.runtimeEpoch, answer.challenge),
          ),
          local.machine.publicKey,
          Buffer.from(body.proof, 'base64url'),
        ),
      ).toBe(true)
      expect(host.beats).toEqual([])
      await host.target()?.drain('SIGTERM')
      expect(await run).toBe(0)
      expect(existsSync(path)).toBe(false)
    } finally {
      await host.cleanup()
    }
  }, 30_000)

  it('in standby serves owner calls only, then the lanes once the migration commit leaves standby', async () => {
    const host = await localRunMachine({
      enrolled: false,
      marker: true,
      standby: true,
      heartbeat: 'accepted',
    })
    try {
      hooks.machine = host.machine
      const local = await writeLocalIdentity(
        dirname(host.control.configPath),
        host.control.context.uid,
      )
      const path = await socketPath()
      const context = host.context()
      // The socket checks iat against run's clock, which the control fixture fakes.
      const clock = context.now ?? Date.now
      let daemon: LocalDaemon | undefined
      const starter = createLocalSocketStarter(context, { candidates: [path] })
      const run = runHost({
        ...context,
        startLocalSocket: (started, store) => {
          daemon = started
          return starter(started, store)
        },
      })
      await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 10_000 })
      const desktop = await ownerConnection(path, local, clock)
      expect(desktop.frames[0]).toMatchObject({ ownerLocal: true, capabilities: [] })
      desktop.send({ type: 'call', id: 'status', method: 'machine.local' })
      desktop.send({
        type: 'call',
        id: 'enroll',
        method: 'machine.enroll',
        params: { action: 'begin' },
      })
      expect(await result(desktop, 'status')).toMatchObject({
        ok: true,
        data: {
          machineId: local.machineId,
          mode: 'local',
          ownerLock: { held: false, standby: true },
        },
      })
      expect(await result(desktop, 'enroll')).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      })
      desktop.send({ type: 'subscribe', id: 'lanes', topic: 'lanes' })
      await vi.waitFor(() =>
        expect(desktop.frames).toContainEqual({
          type: 'subscribe-failed',
          id: 'lanes',
          code: 'forbidden',
        }),
      )

      await daemon?.leaveStandby()
      await vi.waitFor(() => expect(desktop.closed()).toEqual({ code: 1001 }), { timeout: 10_000 })
      const again = await ownerConnection(path, local, clock)
      expect(again.frames[0]).toMatchObject({
        ownerLocal: true,
        capabilities: expect.arrayContaining(['sessions.read', 'sessions.control']),
      })
      again.send({ type: 'call', id: 'status', method: 'machine.local' })
      expect(await result(again, 'status')).toMatchObject({
        data: { ownerLock: { held: true, holder: 'daemon', pid: process.pid, standby: false } },
      })
      again.close()
      await host.target()?.drain('SIGTERM')
      expect(await run).toBe(0)
      expect(existsSync(join(host.state, HOST_SIDECARS.localRun))).toBe(false)
    } finally {
      await host.cleanup()
    }
  }, 30_000)

  it('serves the Brain registration as an owner call and drops it on disconnect', async () => {
    const host = await localRunMachine({
      enrolled: false,
      marker: true,
      standby: true,
      heartbeat: 'accepted',
    })
    const path = await socketPath()
    const log = vi.fn()
    const context = { ...host.context(), log }
    const local = await writeLocalIdentity(dirname(context.configPath), context.uid)
    const run = runHost({
      ...context,
      startLocalSocket: createLocalSocketStarter(context, { candidates: [path] }),
    })
    try {
      await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 10_000 })
      const desktop = await ownerConnection(path, local, context.now ?? Date.now)
      const token = 'synthetic-private-token'
      desktop.send({
        type: 'call',
        id: 'register',
        method: 'app.service.register',
        params: {
          service: 'brain',
          endpoint: join(dirname(path), 'brain.sock'),
          token,
          recall: true,
        },
      })
      expect(await result(desktop, 'register')).toEqual({
        type: 'result',
        id: 'register',
        ok: true,
        data: { registered: true },
      })
      desktop.send({ type: 'call', id: 'live', method: 'machine.local' })
      expect(await result(desktop, 'live')).toMatchObject({
        data: { appServices: { brain: 'registered' } },
      })
      desktop.close()
      await vi.waitFor(() => expect(desktop.closed()).toBeTruthy())
      const again = await ownerConnection(path, local, context.now ?? Date.now)
      again.send({ type: 'call', id: 'closed', method: 'machine.local' })
      expect(await result(again, 'closed')).toMatchObject({
        data: { appServices: { brain: 'known' } },
      })
      again.close()
      expect(JSON.stringify([...log.mock.calls, ...desktop.frames, ...again.frames])).not.toContain(
        token,
      )
    } finally {
      await host.target()?.drain('SIGTERM')
      await run
      await host.cleanup()
    }
  })

  it('exits 78 when the marker exists but the local identity does not', async () => {
    const host = await localRunMachine({ enrolled: false, marker: true, heartbeat: 'accepted' })
    try {
      hooks.machine = host.machine
      const path = await socketPath()
      const context = host.context()
      const run = runHost({
        ...context,
        startLocalSocket: createLocalSocketStarter(context, { candidates: [path] }),
      })
      expect(await run).toBe(78)
      expect(host.control.output).toEqual([
        'The local service identity is not usable. Run phosphor setup --local again.',
      ])
      expect(existsSync(path)).toBe(false)
    } finally {
      await host.cleanup()
    }
  }, 30_000)

  it('exits 78 with one line when the socket folder is not private', async () => {
    const host = await localRunMachine({ enrolled: false, marker: true, heartbeat: 'accepted' })
    try {
      hooks.machine = host.machine
      await writeLocalIdentity(dirname(host.control.configPath), host.control.context.uid)
      const path = await socketPath()
      await mkdir(dirname(path), { mode: 0o755 })
      await chmod(dirname(path), 0o755)
      const context = host.context()
      const run = runHost({
        ...context,
        startLocalSocket: createLocalSocketStarter(context, { candidates: [path] }),
      })
      expect(await run).toBe(78)
      expect(host.control.output).toEqual([
        'The local socket folder must be a folder you own with mode 0700.',
      ])
      expect(existsSync(path)).toBe(false)
    } finally {
      await host.cleanup()
    }
  }, 30_000)
})
