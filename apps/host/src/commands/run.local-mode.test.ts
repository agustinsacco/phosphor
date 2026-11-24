import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { acquireOwnerLock, readOwnerLock } from '@phosphor/session-runtime/owner-lock/owner-lock'
import { hostId } from '../control/__fixtures__/machine'
import type * as Runtime from '../session/runtime'
import type * as Routines from '../routines/service'
import { runHost } from './run'
import { OWNER_RETRY_MS, type LocalDaemon, type StartLocalSocket } from './run-local'
import { localRunMachine } from './__fixtures__/run-local'

/** What run started and stopped, in order. */
const hooks = vi.hoisted(() => ({
  order: [] as string[],
  machine: null as Omit<Runtime.HostMachine, 'log'> | null,
}))
vi.mock('./doctor', () => ({
  inspectHost: vi.fn(async () => {
    hooks.order.push('inspect')
    return { machine: hooks.machine, secrets: [] }
  }),
}))
vi.mock('../api/server', () => ({
  startApi: () => {
    hooks.order.push('api')
    return {
      deliver: () => {},
      isConnected: () => false,
      stop: async () => {
        hooks.order.push('api.stop')
      },
    }
  },
}))
vi.mock('../session/runtime', async (original) => {
  const module = await original<typeof Runtime>()
  return {
    ...module,
    createHostRuntime: (...args: Parameters<typeof module.createHostRuntime>) => {
      hooks.order.push('runtime')
      const runtime = module.createHostRuntime(...args)
      const drain = runtime.drain.bind(runtime)
      runtime.drain = (reason) => {
        hooks.order.push('runtime.drain')
        return drain(reason)
      }
      return runtime
    },
  }
})
vi.mock('../routines/service', async (original) => {
  const module = await original<typeof Routines>()
  return {
    ...module,
    createHostRoutines: (...args: Parameters<typeof module.createHostRoutines>) => {
      const routines = module.createHostRoutines(...args)
      const start = routines.start.bind(routines)
      routines.start = () => {
        hooks.order.push('routines.start')
        start()
      }
      return routines
    },
  }
})
afterEach(() => {
  hooks.order = []
  hooks.machine = null
})

describe('run without the local-mode marker (characterization)', () => {
  it('exits 69 when unenrolled, before any network call or lane', async () => {
    const host = await localRunMachine({ enrolled: false, marker: false, heartbeat: 'accepted' })
    try {
      hooks.machine = host.machine
      expect(await runHost(host.context())).toBe(69)
      expect(host.control.output).toEqual(['Run phosphor setup first.'])
      expect(host.beats).toEqual([])
      expect(hooks.order).toEqual([])
    } finally {
      await host.cleanup()
    }
  })

  it('exits 77 on a 410 and drains its lanes', async () => {
    const host = await localRunMachine({ enrolled: true, marker: false, heartbeat: 'gone' })
    try {
      hooks.machine = host.machine
      expect(await runHost(host.context())).toBe(77)
      expect(host.beats).toEqual(['running'])
      expect(hooks.order).toEqual([
        'inspect',
        'runtime',
        'routines.start',
        'api',
        'api.stop',
        'runtime.drain',
      ])
    } finally {
      await host.cleanup()
    }
  })
})

/** True once `run` has ended; checked after the event loop has turned. */
async function ended(run: Promise<number>): Promise<boolean> {
  return Promise.race([
    run.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
  ])
}

describe('run with the local-mode marker', () => {
  it('R2: a 410 closes the TCP API and keeps the lanes until the service stops', async () => {
    const host = await localRunMachine({ enrolled: true, marker: true, heartbeat: 'gone' })
    try {
      hooks.machine = host.machine
      const run = runHost(host.context())
      await vi.waitFor(() => expect(hooks.order).toContain('api.stop'), { timeout: 10_000 })
      expect(await ended(run)).toBe(false)
      expect(hooks.order).not.toContain('runtime.drain')
      await host.target()?.drain('SIGTERM')
      expect(await run).toBe(0)
      expect(hooks.order).toContain('runtime.drain')
      expect(host.beats.filter((beat) => beat === 'running')).toEqual(['running'])
    } finally {
      await host.cleanup()
    }
  }, 20_000)

  it('starts its lanes without an identity, with no heartbeat and no TCP API', async () => {
    const host = await localRunMachine({ enrolled: false, marker: true, heartbeat: 'accepted' })
    try {
      hooks.machine = host.machine
      const run = runHost(host.context())
      await vi.waitFor(() => expect(hooks.order).toContain('routines.start'), { timeout: 10_000 })
      expect(await ended(run)).toBe(false)
      await host.target()?.drain('SIGTERM')
      expect(await run).toBe(0)
      expect(hooks.order).toEqual(['inspect', 'runtime', 'routines.start', 'runtime.drain'])
      expect(host.beats).toEqual([])
    } finally {
      await host.cleanup()
    }
  }, 20_000)
})

/** Captures the local daemon through D3's socket seam and records the socket's life. */
function socketSeam() {
  let daemon: LocalDaemon | undefined
  const startLocalSocket: StartLocalSocket = (started) => {
    daemon = started
    hooks.order.push('socket')
    return {
      stop: async () => {
        hooks.order.push('socket.stop')
      },
    }
  }
  return {
    startLocalSocket,
    daemon: () => {
      if (!daemon) throw new Error('The socket seam was not started')
      return daemon
    },
  }
}

describe('the local daemon', () => {
  it('in standby opens its store and starts nothing else, and never takes the owner lock', async () => {
    const host = await localRunMachine({
      enrolled: true,
      marker: true,
      standby: true,
      heartbeat: 'accepted',
    })
    try {
      hooks.machine = host.machine
      const seam = socketSeam()
      const run = runHost({ ...host.context(), startLocalSocket: seam.startLocalSocket })
      await vi.waitFor(() => expect(hooks.order).toContain('socket'), { timeout: 10_000 })
      expect(await ended(run)).toBe(false)
      expect(hooks.order).toEqual(['socket'])
      expect(host.beats).toEqual([])
      expect(existsSync(join(host.state, 'state.sqlite'))).toBe(true)
      expect(await readOwnerLock(host.pi.agentDir)).toBeNull()
      const daemon = seam.daemon()
      expect(daemon.standby()).toBe(true)
      expect(daemon.link()).toBeNull()
      await expect(daemon.beginEnrollment()).rejects.toMatchObject({ reason: 'standby' })

      await daemon.leaveStandby()
      await vi.waitFor(() => expect(host.beats).toContain('running'), { timeout: 10_000 })
      expect(existsSync(join(host.state, HOST_SIDECARS.standby))).toBe(false)
      expect(await readOwnerLock(host.pi.agentDir)).toMatchObject({
        owner: 'daemon',
        pid: process.pid,
      })
      await host.target()?.drain('SIGTERM')
      expect(await run).toBe(0)
      expect(hooks.order.slice(0, 5)).toEqual([
        'socket',
        'inspect',
        'runtime',
        'routines.start',
        'api',
      ])
      expect(hooks.order).toContain('runtime.drain')
      // The socket stops last, after the lanes, then the owner lock is released.
      expect(hooks.order.at(-1)).toBe('socket.stop')
      expect(await readOwnerLock(host.pi.agentDir)).toBeNull()
    } finally {
      await host.cleanup()
    }
  }, 30_000)

  it('waits while a live Desktop holds the owner lock, logging it once, then takes it', async () => {
    const host = await localRunMachine({ enrolled: false, marker: true, heartbeat: 'accepted' })
    const desktop = await acquireOwnerLock(host.pi.agentDir, 'desktop')
    try {
      hooks.machine = host.machine
      const retries: (() => void)[] = []
      const events: string[] = []
      const context = host.context()
      const run = runHost({
        ...context,
        log: (_scope, event) => events.push(event),
        wait: (ms, signal) =>
          ms === OWNER_RETRY_MS
            ? new Promise<void>((resolve) => retries.push(resolve))
            : (context.wait?.(ms, signal) ?? Promise.resolve()),
      })
      await vi.waitFor(() => expect(retries).toHaveLength(1), { timeout: 10_000 })
      retries[0]?.()
      await vi.waitFor(() => expect(retries).toHaveLength(2), { timeout: 10_000 })
      expect(events.filter((event) => event === 'owner.busy')).toEqual(['owner.busy'])
      expect(hooks.order).toEqual([])
      expect(await readOwnerLock(host.pi.agentDir)).toMatchObject({ owner: 'desktop' })
      await desktop.release()
      retries[1]?.()
      await vi.waitFor(() => expect(hooks.order).toContain('routines.start'), { timeout: 10_000 })
      expect(await readOwnerLock(host.pi.agentDir)).toMatchObject({ owner: 'daemon' })
      await host.target()?.drain('SIGTERM')
      expect(await run).toBe(0)
    } finally {
      await desktop.release()
      await host.cleanup()
    }
  }, 30_000)

  it('exits 78 with one line when the marker is not usable', async () => {
    const host = await localRunMachine({ enrolled: false, marker: false, heartbeat: 'accepted' })
    try {
      await writeFile(
        join(dirname(host.control.configPath), HOST_SIDECARS.localMode),
        JSON.stringify({ version: 2 }),
        { mode: 0o600 },
      )
      expect(await runHost(host.context())).toBe(78)
      expect(host.control.output).toEqual([
        'The local service marker is not usable. Run phosphor setup --local again.',
      ])
      expect(host.beats).toEqual([])
      expect(hooks.order).toEqual([])
    } finally {
      await host.cleanup()
    }
  })

  it('enrolls in-process and starts the heartbeat and TCP API without touching lanes', async () => {
    const host = await localRunMachine({ enrolled: false, marker: true, heartbeat: 'accepted' })
    try {
      hooks.machine = host.machine
      const seam = socketSeam()
      const context = host.context()
      const run = runHost({
        ...context,
        startLocalSocket: seam.startLocalSocket,
        // Enrollment polls answer at once; longer waits stay real and abortable.
        wait: (ms, signal) =>
          ms <= 5000 ? Promise.resolve() : (context.wait?.(ms, signal) ?? Promise.resolve()),
      })
      await vi.waitFor(() => expect(hooks.order).toContain('routines.start'), { timeout: 10_000 })
      const daemon = seam.daemon()
      expect(daemon.link()?.mode()).toBe('local')
      const offer = await daemon.beginEnrollment()
      expect(offer.userCode).toBe('BCDFGHJK')
      await vi.waitFor(() => expect(host.beats).toContain('running'), { timeout: 10_000 })
      expect(daemon.link()?.state()).toMatchObject({ kind: 'enrolled', hostId })
      await expect(daemon.beginEnrollment()).rejects.toMatchObject({ reason: 'enrolled' })
      expect(hooks.order).toEqual(['socket', 'inspect', 'runtime', 'routines.start', 'api'])
      await host.target()?.drain('SIGTERM')
      expect(await run).toBe(0)
    } finally {
      await host.cleanup()
    }
  }, 30_000)
})
