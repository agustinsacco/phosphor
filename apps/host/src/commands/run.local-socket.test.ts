import { verify } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { helloProofMessage } from '@phosphor/shared/host-protocol'
import type * as ApiServer from '../api/server'
import type * as Runtime from '../session/runtime'
import { socketHello } from '../api/__fixtures__/local-client'
import { writeLocalIdentity } from '../owner/__fixtures__/local-identity'
import { ownerConnection, result } from '../owner/__fixtures__/owner-connection'
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

// No TCP listener, including when enrollment starts the heartbeat.
vi.mock('../api/server', async (original) => ({
  ...(await original<typeof ApiServer>()),
  startApi: () => ({ deliver() {}, connections: () => [], stop: async () => {} }),
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

const pauseBegin = { action: 'begin', purpose: 'update' }

async function expectLease(
  stream: Awaited<ReturnType<typeof ownerConnection>>,
  path: string,
  active: boolean,
) {
  stream.send({
    type: 'call',
    id: 'lease',
    method: 'owner.lease.take',
    params: { paths: [path], ttlMs: 1000 },
  })
  expect(await result(stream, 'lease')).toMatchObject(
    active
      ? { ok: true, data: { leaseId: expect.any(String) } }
      : {
          ok: false,
          error: { code: 'forbidden', message: "Lanes on this Mac aren't running yet." },
        },
  )
}

/** D4: standby runs no lanes, so there is nothing to pause. */
async function pauseRefusedInStandby(owner: Awaited<ReturnType<typeof ownerConnection>>) {
  owner.send({ type: 'call', id: 'pause', method: 'machine.pause', params: pauseBegin })
  expect(await result(owner, 'pause')).toMatchObject({ ok: false, error: { code: 'unsupported' } })
}

/** D4: no turn is in flight, so the pause takes hold at once; Cancel ends it. */
async function pauseAndCancel(owner: Awaited<ReturnType<typeof ownerConnection>>) {
  owner.send({ type: 'call', id: 'idle', method: 'machine.local' })
  expect(await result(owner, 'idle')).toMatchObject({
    data: { pause: { kind: 'none' }, lastUpdate: null },
  })
  owner.send({ type: 'call', id: 'pause', method: 'machine.pause', params: pauseBegin })
  expect(await result(owner, 'pause')).toMatchObject({ ok: true, data: { kind: 'paused' } })
  owner.send({ type: 'call', id: 'paused', method: 'machine.local' })
  expect(await result(owner, 'paused')).toMatchObject({ data: { pause: { kind: 'paused' } } })
  owner.send({ type: 'call', id: 'cancel', method: 'machine.pause', params: { action: 'cancel' } })
  expect(await result(owner, 'cancel')).toMatchObject({ ok: true, data: { kind: 'none' } })
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

  it('keeps ready.hello.hostId on the owner socket across enrollment', async () => {
    const host = await localRunMachine({ enrolled: false, marker: true, heartbeat: 'accepted' })
    hooks.machine = host.machine
    const path = await socketPath()
    const context = host.context()
    const local = await writeLocalIdentity(dirname(context.configPath), context.uid)
    let daemon: LocalDaemon | undefined
    const starter = createLocalSocketStarter(context, { candidates: [path] })
    const run = runHost({
      ...context,
      startLocalSocket: (d, store) => {
        daemon = d
        return starter(d, store)
      },
      wait: (ms, signal) => (ms <= 5000 ? Promise.resolve() : context.wait!(ms, signal)),
    })
    try {
      await vi.waitFor(() => expect(daemon?.link()?.mode()).toBe('local'), { timeout: 10_000 })
      const before = await ownerConnection(path, local, context.now ?? Date.now)
      expect(before.frames[0]).toMatchObject({ hello: { hostId: local.machineId } })
      before.send({
        type: 'call',
        id: 'begin',
        method: 'machine.enroll',
        params: { action: 'begin' },
      })
      expect(await result(before, 'begin')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(host.beats).toContain('running'), { timeout: 10_000 })
      before.close()
      const after = await ownerConnection(path, local, context.now ?? Date.now)
      expect(after.frames[0]).toMatchObject({ hello: { hostId: local.machineId } })
      after.send({ type: 'call', id: 'status', method: 'machine.local' })
      expect(await result(after, 'status')).toMatchObject({
        data: { mode: 'enrolled', machineId: local.machineId },
      })
      after.close()
    } finally {
      await host.target()?.drain('SIGTERM')
      await run
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
      await expectLease(desktop, host.state, false)
      await pauseRefusedInStandby(desktop)
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
      await expectLease(again, host.state, true)
      await pauseAndCancel(again)
      again.close()
      await host.target()?.drain('SIGTERM')
      expect(await run).toBe(0)
      expect(existsSync(join(host.state, HOST_SIDECARS.localRun))).toBe(false)
    } finally {
      await host.cleanup()
    }
  }, 30_000)

  it('machine.owner: acquire leaves standby; release writes the marker and exits 75 for a restart in standby', async () => {
    const host = await localRunMachine({
      enrolled: false,
      marker: true,
      standby: true,
      heartbeat: 'accepted',
    })
    const path = await socketPath()
    const context = host.context()
    const local = await writeLocalIdentity(dirname(context.configPath), context.uid)
    const clock = context.now ?? Date.now
    const run = runHost({
      ...context,
      startLocalSocket: createLocalSocketStarter(context, { candidates: [path] }),
    })
    const marker = join(host.state, HOST_SIDECARS.standby)
    hooks.machine = host.machine
    try {
      await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 10_000 })
      const desktop = await ownerConnection(path, local, clock)
      desktop.send({
        type: 'call',
        id: 'idle',
        method: 'machine.owner',
        params: { action: 'release' },
      })
      expect(await result(desktop, 'idle')).toMatchObject({
        ok: true,
        data: { held: false, standby: true },
      })
      desktop.send({
        type: 'call',
        id: 'own',
        method: 'machine.owner',
        params: { action: 'acquire' },
      })
      expect(await result(desktop, 'own')).toMatchObject({ ok: true, data: { standby: false } })
      expect(existsSync(marker)).toBe(false)
      await vi.waitFor(() => expect(desktop.closed()).toEqual({ code: 1001 }), { timeout: 10_000 })
      const again = await ownerConnection(path, local, clock)
      again.send({
        type: 'call',
        id: 'free',
        method: 'machine.owner',
        params: { action: 'release' },
      })
      expect(await result(again, 'free')).toMatchObject({
        ok: true,
        data: { held: true, holder: 'daemon', standby: true },
      })
      expect(existsSync(marker)).toBe(true)
      expect(await run).toBe(75)
      expect(existsSync(join(host.state, HOST_SIDECARS.localRun))).toBe(false)
    } finally {
      await host.target()?.drain('SIGTERM')
      await run
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
