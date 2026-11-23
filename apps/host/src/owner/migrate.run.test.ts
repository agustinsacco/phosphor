import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { readOwnerLock } from '@phosphor/session-runtime/owner-lock/owner-lock'
import type * as Runtime from '../session/runtime'
import { runHost } from '../commands/run'
import type { LocalDaemon, StartLocalSocket } from '../commands/run-local'
import { localRunMachine } from '../commands/__fixtures__/run-local'
import type { HostStore } from '../lanes/store'
import { writeLocalIdentity } from './__fixtures__/local-identity'
import { ownerConnection, result } from './__fixtures__/owner-connection'
import { migrationOwnerHandlers } from './migrate'
import { createLocalSocketStarter } from './socket'
import { withMigrationRecords } from './staging'

const hooks = vi.hoisted(() => ({
  order: [] as string[],
  machine: null as Omit<Runtime.HostMachine, 'log'> | null,
}))
vi.mock('../commands/doctor', () => ({
  inspectHost: vi.fn(async () => {
    hooks.order.push('inspect')
    return { machine: hooks.machine, secrets: [] }
  }),
}))
const folders: string[] = []
afterEach(async () => {
  hooks.order = []
  hooks.machine = null
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

/** Captures the daemon and its store through D3's socket seam. */
function socketSeam() {
  let seen: { daemon: LocalDaemon; store: HostStore } | undefined
  const startLocalSocket: StartLocalSocket = (daemon, store) => {
    seen = { daemon, store }
    hooks.order.push('socket')
    return { stop: async () => {} }
  }
  return {
    startLocalSocket,
    seen: () => {
      if (!seen) throw new Error('The socket seam was not started')
      return seen
    },
  }
}

describe('leaving standby after a migration commit', () => {
  it('re-reads the config, so a folder imported during standby takes lanes without a restart', async () => {
    const host = await localRunMachine({
      enrolled: false,
      marker: true,
      standby: true,
      heartbeat: 'accepted',
    })
    try {
      hooks.machine = host.machine
      const seam = socketSeam()
      const run = runHost({ ...host.context(), startLocalSocket: seam.startLocalSocket })
      await vi.waitFor(() => expect(hooks.order).toContain('socket'), { timeout: 10_000 })
      const { daemon, store } = seam.seen()
      // What the folders importer leaves on disk while the daemon waits in standby.
      const folder = join(host.control.root, 'imported')
      await mkdir(folder)
      const config = JSON.parse(await readFile(host.control.configPath, 'utf8')) as object
      await writeFile(
        host.control.configPath,
        JSON.stringify({ ...config, repositories: [folder] }),
        { mode: 0o600 },
      )

      await daemon.leaveStandby()
      await vi.waitFor(() => expect(hooks.order).toContain('inspect'), { timeout: 10_000 })
      const repository = store.listRepositories().find((r) => r.name === 'imported')
      expect(repository).toBeDefined()
      const lane = store.ensureLane({
        repositoryId: repository?.id ?? '',
        cwd: repository?.path ?? '',
        sessionFile: null,
      })
      expect(store.listLanes().map((l) => l.laneId)).toContain(lane.laneId)
      await host.target()?.drain('SIGTERM')
      expect(await run).toBe(0)
    } finally {
      await host.cleanup()
    }
  }, 30_000)
})

type Machine = Awaited<ReturnType<typeof localRunMachine>>

/** A standby daemon serving P4a's owner methods on a short temporary socket. */
async function standbyDaemon() {
  const host = await localRunMachine({
    enrolled: false,
    marker: true,
    standby: true,
    heartbeat: 'accepted',
  })
  hooks.machine = host.machine
  const local = await writeLocalIdentity(dirname(host.control.configPath), host.control.context.uid)
  const short = await mkdtemp(join(tmpdir(), 'p4a-'))
  folders.push(short)
  return { host, local, path: join(short, 'run', 'phosphor.sock') }
}

/** Starts run and connects as Desktop once the socket accepts connections. */
async function startRun(daemon: Awaited<ReturnType<typeof standbyDaemon>>) {
  const context = daemon.host.context()
  const owner = migrationOwnerHandlers(context)
  const run = runHost({
    ...context,
    startLocalSocket: createLocalSocketStarter(context, { candidates: [daemon.path], owner }),
  })
  await vi.waitFor(() => expect(existsSync(daemon.path)).toBe(true), { timeout: 10_000 })
  const desktop = await ownerConnection(daemon.path, daemon.local, context.now ?? Date.now)
  let calls = 0
  const ask = async (method: string, params?: unknown) => {
    const id = `c${calls++}`
    desktop.send({ type: 'call', id, method, ...(params === undefined ? {} : { params }) })
    return result(desktop, id)
  }
  return { run, desktop, ask }
}

async function stop(host: Machine, run: Promise<number>) {
  await host.target()?.drain('SIGTERM')
  expect(await run).toBe(0)
}

describe('owner.migrate over the owner socket', () => {
  it('Desktop begins, commits, and only then the daemon takes the owner lock and starts lanes', async () => {
    const daemon = await standbyDaemon()
    const { host } = daemon
    try {
      const { run, desktop, ask } = await startRun(daemon)
      const migrationId = randomUUID()
      expect(
        await ask('owner.migrate.begin', { migrationId, desktopVersion: '1.0.0' }),
      ).toMatchObject({ ok: true, data: { state: 'staged' } })
      expect(await ask('owner.index')).toMatchObject({
        ok: true,
        data: { owning: false, lanes: [] },
      })
      expect(await readOwnerLock(host.pi.agentDir)).toBeNull()
      expect(hooks.order).toEqual([])

      expect(await ask('owner.migrate.commit', { migrationId })).toMatchObject({
        ok: true,
        data: { state: 'committed' },
      })
      expect(existsSync(join(host.state, HOST_SIDECARS.standby))).toBe(false)
      await vi.waitFor(() => expect(hooks.order).toContain('inspect'), { timeout: 10_000 })
      expect(await readOwnerLock(host.pi.agentDir)).toMatchObject({ owner: 'daemon' })
      await vi.waitFor(() => expect(desktop.closed()).toEqual({ code: 1001 }), { timeout: 10_000 })
      await stop(host, run)
    } finally {
      await host.cleanup()
    }
  }, 30_000)

  it('after a restart with a staged migration it never takes the owner lock while the marker exists', async () => {
    const daemon = await standbyDaemon()
    const { host } = daemon
    try {
      const first = await startRun(daemon)
      const migrationId = randomUUID()
      await first.ask('owner.migrate.begin', { migrationId, desktopVersion: '1.0.0' })
      first.desktop.close()
      await stop(host, first.run)

      const second = await startRun(daemon)
      expect(await second.ask('owner.migrate.status', { migrationId })).toMatchObject({
        data: { state: 'staged' },
      })
      expect(await second.ask('owner.migrate.abort', { migrationId })).toMatchObject({
        data: { state: 'aborted' },
      })
      expect(await second.ask('machine.local')).toMatchObject({
        data: { ownerLock: { held: false, standby: true } },
      })
      expect(await readOwnerLock(host.pi.agentDir)).toBeNull()
      expect(hooks.order).toEqual([])
      second.desktop.close()
      await stop(host, second.run)
    } finally {
      await host.cleanup()
    }
  }, 30_000)

  it('a commit made durable before a crash rolls forward at the next start', async () => {
    const daemon = await standbyDaemon()
    const { host } = daemon
    try {
      const first = await startRun(daemon)
      const migrationId = randomUUID()
      await first.ask('owner.migrate.begin', { migrationId, desktopVersion: '1.0.0' })
      first.desktop.close()
      await stop(host, first.run)
      // The commit row reached disk; the process died before the marker went.
      await withMigrationRecords(host.state, host.control.context.uid, Date.now, (records) => {
        const row = records.get(migrationId)
        if (row) records.commit(row)
      })
      expect(existsSync(join(host.state, HOST_SIDECARS.standby))).toBe(true)

      const second = await startRun(daemon)
      await vi.waitFor(() => expect(hooks.order).toContain('inspect'), { timeout: 10_000 })
      expect(existsSync(join(host.state, HOST_SIDECARS.standby))).toBe(false)
      expect(existsSync(join(host.state, 'owner-migration', migrationId))).toBe(false)
      expect(await readOwnerLock(host.pi.agentDir)).toMatchObject({ owner: 'daemon' })
      await stop(host, second.run)
    } finally {
      await host.cleanup()
    }
  }, 30_000)
})
