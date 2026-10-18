import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdir, lstat } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import type { ControlMachine } from '../control/__fixtures__/machine'
import { identityDirectory } from '../control/identity'
import type * as Lock from '../control/lock'
import { loadHostConfig } from '../config/load'
import { reconcile } from '../lanes/reconcile'
import type { HostStore } from '../lanes/store'
import { createShutdown } from '../shutdown'
import { createHeartbeat } from '../control/heartbeat'
import { runCli } from '../cli'
import { RELEASE_WAIT_MS, runHost, type RunContext } from './run'
import {
  createRunFixture,
  readiness,
  deferred,
  waitForRunEvent,
  heartbeatBarrier,
} from './__fixtures__/run'

const releaseEvents = vi.hoisted(() => [] as string[])
vi.mock('../control/lock', async (original) => {
  const module = await original<typeof Lock>()
  return {
    ...module,
    acquireIdentityLock: async (...args: Parameters<typeof module.acquireIdentityLock>) => {
      const release = await module.acquireIdentityLock(...args)
      if (args[3] !== '.run-lock') return release
      return async () => {
        await release()
        releaseEvents.push('released')
      }
    },
  }
})

let machine: ControlMachine
let context: () => RunContext
beforeEach(async () => {
  releaseEvents.length = 0
  const fixture = await createRunFixture()
  machine = fixture.machine
  context = fixture.context
})
afterEach(async () => {
  await machine.cleanup()
})
describe('phosphor run', () => {
  it('dispatches CLI run through one shutdown attachment and sends stopping on SIGTERM', async () => {
    await machine.enrollOld()
    const exits: number[] = []
    const atExit: string[][] = []
    const directory = identityDirectory(machine.configPath)
    const shutdown = createShutdown({
      exit: (code) => {
        releaseEvents.push('exit')
        exits.push(code)
        // The process ends here: the run lock and its gate must already be gone.
        atExit.push(readdirSync(directory).filter((name) => name.startsWith('.run-lock')))
      },
      stderr: () => {},
      stopProbes: () => {},
    })
    let attached = 0
    let detached = 0
    const heartbeat = heartbeatBarrier()
    const run = runCli(
      ['run', '--config', machine.configPath],
      { stdout: () => {}, stderr: () => {} },
      {
        ...context(),
        home: machine.root,
        nodeVersion: process.versions.node,
        defaultResourceRoot: '/unused',
        control: {
          signal: machine.abort.signal,
          wait: (ms, signal) => setTimeout(ms, undefined, { signal }),
          fetch: heartbeat.fetch,
        },
        attach: (target) => {
          attached++
          const detach = shutdown.attach(target)
          return () => {
            detached++
            detach()
          }
        },
      },
    )
    try {
      await waitForRunEvent(heartbeat.running, run)
      await shutdown.signal('SIGTERM')
      expect(releaseEvents).toEqual(['released', 'exit'])
    } finally {
      machine.abort.abort()
      await run
    }
    expect(await run).toBe(0)
    expect(heartbeat.states).toEqual(['running', 'stopping'])
    expect(exits).toEqual([0])
    expect(atExit).toEqual([[]])
    expect(attached).toBe(1)
    expect(detached).toBe(1)
  })
  it('waits for slow config loading past the release timeout on SIGTERM', async () => {
    await machine.enrollOld()
    const loading = deferred()
    const paused = deferred()
    const exits: number[] = []
    const atExit: string[][] = []
    const shutdown = createShutdown({
      exit: (code) => {
        exits.push(code)
        atExit.push(
          readdirSync(identityDirectory(machine.configPath)).filter((name) =>
            name.startsWith('.run-lock'),
          ),
        )
      },
      stderr: () => {},
      stopProbes: () => {},
    })
    const running = runHost({
      ...context(),
      attach: shutdown.attach,
      loadConfig: async (...args) => {
        loading.resolve()
        await paused.promise
        return loadHostConfig(...args)
      },
    })
    let stopping: Promise<void> | undefined
    try {
      await waitForRunEvent(loading.promise, running)
      // Startup has reached its I/O barrier. Only now control the shutdown clock.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      stopping = shutdown.signal('SIGTERM')
      await vi.advanceTimersByTimeAsync(RELEASE_WAIT_MS + 100)
      expect(exits).toEqual([])
    } finally {
      // Restore the real clock before allowing config and lock filesystem I/O to continue.
      vi.useRealTimers()
      paused.resolve()
      await Promise.all([running, stopping])
    }
    expect(await running).toBe(0)
    expect(exits).toEqual([0])
    expect(atExit).toEqual([[]])
    expect(machine.calls).toEqual([])
  })
  it.each([
    { second: false, failInit: false },
    { second: true, failInit: false },
    { second: false, failInit: true },
  ])(
    'drains SIGTERM during reconciliation before exit, second: $second, failure: $failInit',
    async ({ second, failInit }) => {
      await machine.enrollOld()
      const scanning = deferred()
      const paused = deferred()
      let opened: HostStore | undefined
      const exits: number[] = []
      const atExit: string[][] = []
      const shutdown = createShutdown({
        exit: (code) => {
          exits.push(code)
          atExit.push(
            readdirSync(identityDirectory(machine.configPath)).filter((name) =>
              name.startsWith('.run-lock'),
            ),
          )
        },
        stderr: () => {},
        stopProbes: () => {},
      })
      const f = context()
      f.attach = shutdown.attach
      f.reconcile = async (store, ...args) => {
        opened = store
        scanning.resolve()
        await paused.promise
        if (failInit) throw new Error('private initialization failure')
        return reconcile(store, ...args)
      }
      const running = runHost(f)
      const signals: Promise<void>[] = []
      try {
        await waitForRunEvent(scanning.promise, running)
        signals.push(shutdown.signal('SIGTERM'))
        if (second) signals.push(shutdown.signal('SIGINT'))
        expect(exits).toEqual([])
      } finally {
        paused.resolve()
        machine.abort.abort()
        await Promise.all([running, ...signals])
      }
      expect(await running).toBe(failInit ? 70 : 0)
      expect(exits).toEqual([second ? 130 : failInit ? 70 : 0])
      expect(machine.output.join('\n')).not.toContain('private initialization failure')
      expect(atExit).toEqual([[]])
      expect(machine.calls).toEqual([])
      const closedStore = opened
      if (!closedStore) throw new Error('store was not opened')
      expect(() => closedStore.listLanes()).toThrow(/closed|not open/)
    },
  )
})

it('shutdown uses run exit 0 on the first signal and 130 immediately on a second SIGINT', async () => {
  const exits: number[] = []
  const shutdown = createShutdown({
    exit: (code) => {
      exits.push(code)
    },
    stderr: () => {},
    stopProbes: () => {},
  })
  const loop = createHeartbeat({
    now: () => 1000,
    random: () => 0,
    hostVersion: '0.0.0-dev.source',
    wait: async () => new Promise(() => {}),
    client: async () => new Promise(() => {}),
    readiness: async () => readiness,
    seq: { read: async () => 0, write: async () => {} },
    log: () => {},
  })
  shutdown.attach({ ...loop, log: { write: () => {}, hide: () => '' } })
  const first = shutdown.signal('SIGTERM')
  await shutdown.signal('SIGINT')
  await first
  expect(exits).toEqual([130])
  const cleanExits: number[] = []
  const clean = createShutdown({
    exit: (code) => {
      cleanExits.push(code)
    },
    stderr: () => {},
    stopProbes: () => {},
  })
  clean.attach({
    drain: async () => ({ state: 'stopped' }),
    exitCode: () => 0,
    log: { write: () => {}, hide: () => '' },
  })
  await clean.signal('SIGTERM')
  expect(cleanExits).toEqual([0])
})

it('keeps a second signal code when it lands while run releases its lock', async () => {
  await machine.enrollOld()
  const exits: number[] = []
  const shutdown = createShutdown({
    exit: (code) => {
      exits.push(code)
    },
    stderr: () => {},
    stopProbes: () => {},
  })
  const heartbeat = heartbeatBarrier()
  const reached = deferred()
  const resume = deferred()
  const f = context()
  f.lockPorts = {
    pid: process.pid,
    isAlive: () => false,
    lstat: async (path) => {
      if (heartbeat.states.includes('stopping') && path.endsWith('.run-lock')) {
        reached.resolve()
        await resume.promise
      }
      return lstat(path)
    },
  }
  f.attach = shutdown.attach
  f.wait = (ms, signal) => setTimeout(ms, undefined, { signal })
  f.fetch = heartbeat.fetch
  const run = runHost(f)
  const signals: Promise<void>[] = []
  try {
    await waitForRunEvent(heartbeat.running, run)
    signals.push(shutdown.signal('SIGTERM'))
    await waitForRunEvent(reached.promise, run)
    signals.push(shutdown.signal('SIGINT'))
    expect(exits).toEqual([])
  } finally {
    resume.resolve()
    machine.abort.abort()
    await Promise.all([run, ...signals])
  }
  // The first signal's waiter ends the process, but with the second's code.
  expect(exits).toEqual([130])
  expect(
    (await readdir(identityDirectory(machine.configPath))).filter((name) =>
      name.startsWith('.run-lock'),
    ),
  ).toEqual([])
})
