import { readdirSync, symlinkSync } from 'node:fs'
import { openStore, type HostStore } from '../lanes/store'
import { loadHostConfig } from '../config/load'
import { reconcile } from '../lanes/reconcile'
import { loadSqlite } from '../lanes/sqlite'
import { hostStateDirectory } from '../lanes/state-dir'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_ROUTES, HOST_HEADERS, type Readiness } from '@phosphor/shared/control-api'
import { controlMachine, type ControlMachine, oldId } from '../control/__fixtures__/machine'
import { identityDirectory } from '../control/identity'
import { acquireIdentityLock } from '../control/lock'
import type { RunContext } from './run'
import { RELEASE_WAIT_MS, runHost } from './run'
import { createShutdown } from '../shutdown'
import { createHeartbeat } from '../control/heartbeat'
import { runCli } from '../cli'

const readiness: Readiness = { pi: 'ok', claude: 'ok', tailscale: 'ok' }
let machine: ControlMachine
beforeEach(async () => {
  machine = await controlMachine()
  const repository = join(machine.root, 'repository')
  await mkdir(repository)
  machine.config.repositories = [repository]
  await writeFile(machine.configPath, JSON.stringify(machine.config), { mode: 0o600 })
})
afterEach(async () => {
  await machine.cleanup()
})
const context = (): RunContext => ({
  ...machine.context,
  env: {
    XDG_STATE_HOME: join(machine.root, 'state'),
    PI_CODING_AGENT_SESSION_DIR: join(machine.root, 'sessions'),
  },
  home: machine.root,
  heartbeat: { readiness: async () => readiness, random: () => 0 },
})
describe('phosphor run', () => {
  it('dispatches CLI run through one shutdown attachment and sends stopping on SIGTERM', async () => {
    await machine.enrollOld()
    const exits: number[] = []
    const atExit: string[][] = []
    const directory = identityDirectory(machine.configPath)
    const shutdown = createShutdown({
      exit: (code) => {
        exits.push(code)
        // The process ends here: the run lock and its gate must already be gone.
        atExit.push(readdirSync(directory).filter((name) => name.startsWith('.run-lock')))
      },
      stderr: () => {},
      stopProbes: () => {},
    })
    let attached = 0
    let detached = 0
    const states: string[] = []
    const run = runCli(
      ['run', '--config', machine.configPath],
      { stdout: () => {}, stderr: () => {} },
      {
        ...context(),
        home: machine.root,
        nodeVersion: process.versions.node,
        defaultResourceRoot: '/unused',
        control: {
          wait: (ms, signal) => setTimeout(ms, undefined, { signal }),
          fetch: async (_url, init) => {
            const request: unknown = JSON.parse(String(init?.body))
            if (
              request === null ||
              typeof request !== 'object' ||
              !('state' in request) ||
              typeof request.state !== 'string'
            )
              throw new Error('invalid request')
            states.push(request.state)
            if (request.state === 'stopping')
              return Response.json({ accepted: true, nextInSec: 30 })
            return new Promise((_resolve, reject) =>
              init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
                once: true,
              }),
            )
          },
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
    await vi.waitFor(() => expect(states).toEqual(['running']))
    const signalled = Date.now()
    await shutdown.signal('SIGTERM')
    // Released, not merely timed out.
    expect(Date.now() - signalled).toBeLessThan(RELEASE_WAIT_MS)
    expect(await run).toBe(0)
    expect(states).toEqual(['running', 'stopping'])
    expect(exits).toEqual([0])
    expect(atExit).toEqual([[]])
    expect(attached).toBe(1)
    expect(detached).toBe(1)
  })
  it('waits for slow config loading past the release timeout on SIGTERM', async () => {
    await machine.enrollOld()
    let entered: () => void = () => {}
    const loading = new Promise<void>((resolve) => {
      entered = resolve
    })
    let resume: () => void = () => {}
    const paused = new Promise<void>((resolve) => {
      resume = resolve
    })
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
        entered()
        await paused
        return loadHostConfig(...args)
      },
    })
    await loading
    const stopping = shutdown.signal('SIGTERM')
    try {
      await setTimeout(RELEASE_WAIT_MS + 100)
      expect(exits).toEqual([])
    } finally {
      resume()
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
      let entered: () => void = () => {}
      const scanning = new Promise<void>((resolve) => {
        entered = resolve
      })
      let resume: () => void = () => {}
      const paused = new Promise<void>((resolve) => {
        resume = resolve
      })
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
        entered()
        await paused
        if (failInit) throw new Error('private initialization failure')
        return reconcile(store, ...args)
      }
      const running = runHost(f)
      await scanning
      const first = shutdown.signal('SIGTERM')
      const later = second ? shutdown.signal('SIGINT') : Promise.resolve()
      expect(exits).toEqual([])
      resume()
      await Promise.all([first, later])
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
  it('refuses unsafe storage and newer schemas with 78, naming state and releasing the lock', async () => {
    await machine.enrollOld()
    const f = context()
    const directory = hostStateDirectory(f.env, f.home)
    await mkdir(join(machine.root, 'state'), { recursive: true, mode: 0o700 })
    symlinkSync(join(machine.root, 'repository'), directory)
    expect(await runHost(f)).toBe(78)
    expect(machine.calls).toEqual([])
    expect(machine.output.join('\n')).toContain(directory)
    expect(await readdir(identityDirectory(machine.configPath))).not.toContain('.run-lock')
    const { unlink } = await import('node:fs/promises')
    await unlink(directory)
    const store = await openStore(directory, f.uid)
    store.close()
    const { DatabaseSync } = await loadSqlite()
    const db = new DatabaseSync(join(directory, 'state.sqlite'))
    db.exec('PRAGMA user_version=2')
    db.close()
    expect(await runHost(f)).toBe(78)
    expect(machine.output.join('\n')).toContain('this state was written by a newer Host')
    expect(machine.calls).toEqual([])
  })
  it('names the state folder on an internal database open failure with 70', async () => {
    await machine.enrollOld()
    const f = context()
    const directory = hostStateDirectory(f.env, f.home)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, 'state.sqlite'), 'not a database', { mode: 0o600 })
    expect(await runHost(f)).toBe(70)
    expect(machine.output.join('\n')).toContain(hostStateDirectory(f.env, f.home))
    expect(machine.calls).toEqual([])
    expect(await readdir(identityDirectory(machine.configPath))).not.toContain('.run-lock')
  })
  it('keeps heartbeating with unavailable repositories, reconciles present ones and logs only a count', async () => {
    await machine.enrollOld()
    await writeFile(
      machine.configPath,
      JSON.stringify({
        ...machine.config,
        repositories: [join(machine.root, 'missing'), ...machine.config.repositories],
      }),
    )
    const f = context()
    const { sessionDirForCwd } = await import('@phosphor/session-runtime/pi/pi-paths')
    const { realpathSync } = await import('node:fs')
    const { randomUUID } = await import('node:crypto')
    const cwd = realpathSync.native(join(machine.root, 'repository'))
    const directory = sessionDirForCwd(cwd, join(machine.root, 'sessions'))
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'session.jsonl'),
      JSON.stringify({ type: 'session', id: randomUUID(), cwd }) + '\n',
    )
    const log = vi.fn()
    f.log = log
    f.fetch = async () => Response.json({ accepted: true, nextInSec: 30 })
    f.wait = async () => {
      machine.abort.abort()
    }
    expect(await runHost(f)).toBe(0)
    expect(log).toHaveBeenCalledWith('host', 'lanes.repositories_unavailable', { count: 1 })
    expect(log).toHaveBeenCalledWith('host', 'lanes.reconciled', {
      repositories: 1,
      lanes: 1,
      added: 1,
      removed: 0,
    })
    expect(
      log.mock.calls.filter(([, name]) => name === 'lanes.repositories_unavailable'),
    ).toHaveLength(1)
    expect(await readdir(identityDirectory(machine.configPath))).not.toContain('.run-lock')
  })
  it('requires enrollment before any network call', async () => {
    expect(await runHost(context())).toBe(69)
    expect(machine.output).toEqual(['Run phosphor login first.'])
    expect(machine.calls).toEqual([])
  })
  it('refuses another control origin without contacting either', async () => {
    await machine.enrollOld()
    await writeFile(
      machine.configPath,
      JSON.stringify({ ...machine.config, control: { url: 'https://other.example' } }),
    )
    const f = context()
    let contacted = false
    f.fetch = async () => {
      contacted = true
      return new Response(null, { status: 410 })
    }
    expect(await runHost(f)).toBe(78)
    expect(contacted).toBe(false)
    expect(machine.calls).toEqual([])
  })
  it('refuses a live run lock with pid and releases the identity lock', async () => {
    await machine.enrollOld()
    const directory = identityDirectory(machine.configPath)
    const release = await acquireIdentityLock(
      directory,
      machine.context.uid,
      undefined,
      '.run-lock',
    )
    try {
      const f = context()
      f.fetch = async () => new Response(null, { status: 410 })
      expect(await runHost(f)).toBe(75)
      expect(machine.output.join('\n')).toContain(`pid ${process.pid}`)
      expect(machine.output.join('\n')).toContain('phosphor run')
      expect(await readdir(directory)).not.toContain('.lock')
    } finally {
      await release()
    }
  })
  it('recovers a dead run lock and persists seq before transport, across restarts and loss', async () => {
    await machine.enrollOld()
    const directory = identityDirectory(machine.configPath)
    await writeFile(
      join(directory, '.run-lock'),
      JSON.stringify({ pid: 123, token: 'a'.repeat(64), startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    )
    let last = 0
    const signatures: string[] = []
    const f = context()
    f.lockPorts = { pid: process.pid, isAlive: (pid) => pid === process.pid }
    f.fetch = async (url, init) => {
      const signature = new Headers(init?.headers).get(HOST_HEADERS.signature)
      if (signature === null) throw new Error('missing signature')
      signatures.push(signature)
      expect(new URL(String(url)).pathname).toBe(CONTROL_ROUTES.hostHeartbeat)
      const value: unknown = JSON.parse(String(init?.body))
      if (
        value === null ||
        typeof value !== 'object' ||
        !('seq' in value) ||
        typeof value.seq !== 'number'
      )
        throw new Error('invalid')
      expect(value.seq).toBeGreaterThan(last)
      last = value.seq
      expect(JSON.parse(await readFile(join(directory, 'heartbeat.json'), 'utf8'))).toEqual({
        version: 1,
        hostId: oldId,
        seq: last,
      })
      expect(await readdir(directory)).not.toContain('.lock')
      return new Response(null, { status: 410 })
    }
    const identity = await machine.store.load()
    for (let attempt = 0; attempt < 2; attempt++) expect(await runHost(f)).toBe(77)
    const { unlink } = await import('node:fs/promises')
    await unlink(join(directory, 'heartbeat.json'))
    f.now = () => last + 1
    expect(await runHost(f)).toBe(77)
    expect(await machine.store.load()).toEqual(identity)
    expect(await readdir(directory)).not.toContain('.run-lock')
    const pem = identity?.key.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(machine.output.join('\n')).not.toContain(pem)
    expect(machine.output.join('\n')).not.toContain('PRIVATE KEY')
    for (const signature of signatures) expect(machine.output.join('\n')).not.toContain(signature)
  })
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

it('records retry delay and removal with exit 77 in the file without exception text', async () => {
  await machine.enrollOld()
  const { createHostLog } = await import('../machine/log')
  const secret = crypto.randomUUID()
  const log = createHostLog(join(machine.root, 'logs'), [])
  let calls = 0
  expect(
    await runHost({
      ...context(),
      log: log.write,
      fetch: async () => {
        calls++
        if (calls === 1) throw new TypeError(secret)
        return new Response(null, { status: 410 })
      },
    }),
  ).toBe(77)
  const text = await readFile(join(machine.root, 'logs', 'phosphor.log'), 'utf8')
  expect(text).toContain('[host] lanes.reconciled')
  expect(text).toContain('"repositories":1,"lanes":0,"added":0,"removed":0')
  expect(text).toContain('[host] retry')
  expect(text).toContain('"delayMs":5000')
  expect(text).toContain('[host] removed')
  expect(text).toContain('"exitCode":77')
  expect(text).toContain('"code":"TypeError"')
  expect(text).not.toContain(secret)
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
  const states: string[] = []
  let hold = false
  let paused: (() => void) | undefined
  let resume: (() => void) | undefined
  const reached = new Promise<void>((resolve) => {
    paused = resolve
  })
  const f = context()
  f.lockPorts = {
    pid: process.pid,
    isAlive: () => false,
    lstat: async (path) => {
      if (hold && path.endsWith('.run-lock')) {
        hold = false
        paused?.()
        await new Promise<void>((resolve) => {
          resume = resolve
        })
      }
      return lstat(path)
    },
  }
  f.attach = shutdown.attach
  f.wait = (ms, signal) => setTimeout(ms, undefined, { signal })
  f.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { state: string }
    states.push(request.state)
    if (request.state === 'stopping') {
      hold = true
      return Response.json({ accepted: true, nextInSec: 30 })
    }
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
    )
  }
  const run = runHost(f)
  await vi.waitFor(() => expect(states).toEqual(['running']))
  const first = shutdown.signal('SIGTERM')
  await reached
  const second = shutdown.signal('SIGINT')
  await setTimeout(20)
  resume?.()
  await Promise.all([first, second, run])
  // The first signal's waiter ends the process, but with the second's code.
  expect(exits).toEqual([130])
  expect(
    (await readdir(identityDirectory(machine.configPath))).filter((name) =>
      name.startsWith('.run-lock'),
    ),
  ).toEqual([])
})
