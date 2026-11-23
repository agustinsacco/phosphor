import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Runtime from '../session/runtime'
import { runHost } from '../commands/run'
import type { LocalDaemon, StartLocalSocket } from '../commands/run-local'
import { localRunMachine } from '../commands/__fixtures__/run-local'
import type { HostStore } from '../lanes/store'

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
afterEach(() => {
  hooks.order = []
  hooks.machine = null
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
