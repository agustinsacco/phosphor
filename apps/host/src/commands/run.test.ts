import { symlinkSync } from 'node:fs'
import { openStore } from '../lanes/store'
import { loadSqlite } from '../lanes/sqlite'
import { hostStateDirectory } from '../lanes/state-dir'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_ROUTES, HOST_HEADERS } from '@phosphor/shared/control-api'
import { type ControlMachine, oldId } from '../control/__fixtures__/machine'
import { identityDirectory } from '../control/identity'
import { acquireIdentityLock } from '../control/lock'
import { runHost, type RunContext } from './run'
import { readRunHealth } from '../update/health'
import type { Drainable } from '../shutdown'
import { HOST_VERSION } from '../version'
import type * as Client from '../control/client'
import { createRunFixture, deferred, waitForRunEvent } from './__fixtures__/run'

const clientHooks = vi.hoisted(() => ({ invalidAnswer: false }))
vi.mock('../control/client', async (original) => {
  const client = await original<typeof Client>()
  return {
    ...client,
    createControlClient: (...args: Parameters<typeof client.createControlClient>) => {
      const real = client.createControlClient(...args)
      return {
        ...real,
        heartbeat: async (...args: Parameters<typeof real.heartbeat>) => {
          const answer = await real.heartbeat(...args)
          // Bypass the client's earlier validator to exercise run's own admission guard.
          return clientHooks.invalidAnswer && args[2].state === 'running'
            ? { ...answer, nextInSec: 0 }
            : answer
        },
      }
    },
  }
})

let machine: ControlMachine
let context: () => RunContext
beforeEach(async () => {
  const fixture = await createRunFixture()
  machine = fixture.machine
  context = fixture.context
})
afterEach(async () => {
  clientHooks.invalidAnswer = false
  await machine.cleanup()
})
describe('phosphor run', () => {
  it.each(['accepted', 'unavailable', 'invalid', 'invalid-client'])(
    'publishes health only after an accepted running heartbeat: %s',
    async (response) => {
      const accepted = response === 'accepted'
      clientHooks.invalidAnswer = response === 'invalid-client'
      await machine.enrollOld()
      let target: Drainable | undefined
      const c = context(),
        state = hostStateDirectory(c.env, c.home)
      let observed = false
      expect(
        await runHost({
          ...c,
          attach: (t) => {
            target = t
            return () => {}
          },
          fetch: async (_url, init) => {
            const body: unknown = JSON.parse(String(init?.body))
            if (body && typeof body === 'object' && 'state' in body && body.state === 'stopping')
              return Response.json({ accepted: true, nextInSec: 30 })
            return accepted || response === 'invalid-client'
              ? Response.json({ accepted: true, nextInSec: 30 })
              : response === 'invalid'
                ? Response.json({ accepted: false, nextInSec: 30 })
                : new Response('', { status: 503 })
          },
          wait: async (ms, signal) => {
            if (ms === 5000 && observed) return setTimeout(ms, undefined, { signal })
            observed = true
            const record = readRunHealth(state)
            if (accepted) {
              expect(record?.version).toBe(HOST_VERSION)
              expect(record?.pid).toBe(process.pid)
            } else expect(record).toBeNull()
            await target?.drain('SIGTERM')
          },
        }),
      ).toBe(0)
      expect(observed).toBe(true)
      if (!accepted) expect(readRunHealth(state)).toBeNull()
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
  it('runs and heartbeats with no configured folders or lanes', async () => {
    await machine.enrollOld()
    await writeFile(machine.configPath, JSON.stringify({ ...machine.config, repositories: [] }), {
      mode: 0o600,
    })
    const f = context()
    const log = vi.fn()
    f.log = log
    f.fetch = async () => Response.json({ accepted: true, nextInSec: 30 })
    f.wait = async () => {
      machine.abort.abort()
    }
    expect(await runHost(f)).toBe(0)
    expect(log).toHaveBeenCalledWith('host', 'lanes.reconciled', {
      repositories: 0,
      lanes: 0,
      added: 0,
      removed: 0,
    })
    const store = await openStore(hostStateDirectory(f.env, f.home), process.getuid?.())
    try {
      expect(store.listRepositories()).toEqual([])
      expect(store.listLanes()).toEqual([])
    } finally {
      store.close()
    }
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
    expect(machine.output).toEqual(['Run phosphor setup first.'])
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
it('keeps run alive and heartbeating when the API port is occupied', async () => {
  const { createServer } = await import('node:http')
  const { once } = await import('node:events')
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  await machine.enrollOld()
  await writeFile(
    machine.configPath,
    JSON.stringify({ ...machine.config, api: { port: address.port } }),
    { mode: 0o600 },
  )
  const f = context()
  const events: string[] = []
  const apiUnavailable = deferred()
  const heartbeatSent = deferred()
  f.log = (_source, event) => {
    events.push(event)
    if (event === 'api.unavailable') apiUnavailable.resolve()
  }
  f.fetch = async () =>
    Response.json({
      accepted: true,
      nextInSec: 30,
      ownerId: '00000000-0000-4000-8000-000000000001',
      epoch: 1,
    })
  f.wait = async (_ms, signal) => {
    if (signal?.aborted) return
    heartbeatSent.resolve()
    await new Promise<void>((resolve) =>
      signal?.addEventListener('abort', () => resolve(), { once: true }),
    )
  }
  let ended = false
  const running = runHost(f).then((code) => {
    ended = true
    return code
  })
  try {
    await waitForRunEvent(
      Promise.all([apiUnavailable.promise, heartbeatSent.promise]).then(() => {}),
      running,
    )
    expect(ended).toBe(false)
    expect(events).toContain('heartbeat')
  } finally {
    machine.abort.abort()
    expect(await running).toBe(0)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('refreshes the endpoint with readiness, caches between beats, and logs only changed route states', async () => {
  await machine.enrollOld()
  const name = 'bee.tail123.ts.net'
  let index = 0
  const logs: unknown[] = []
  const probe = vi.fn(async (_file: string, args: readonly string[]) => ({
    code: 0,
    signal: null,
    stderr: 'private output',
    timedOut: false,
    truncated: false,
    stdout:
      args[0] === 'status'
        ? JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: `${name}.` },
            CertDomains: [name],
          })
        : index < 2
          ? JSON.stringify({
              TCP: { 47615: { HTTPS: true } },
              Web: {
                [`${name}:47615`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:47615' } } },
              },
            })
          : '{}',
  }))
  machine.onWait(() => {
    if (++index === 22) machine.abort.abort()
  })
  const exit = await runHost({
    ...context(),
    heartbeat: {
      random: () => 0,
      readinessPorts: {
        probe,
        which: async (binary) => (binary === 'tailscale' ? '/fake/tailscale' : null),
        isNodeScript: async () => false,
        isFile: async () => false,
        resolve: async () => null,
      },
    },
    log: (scope, event, fields) => {
      if (event === 'tailscale.endpoint') logs.push({ scope, event, fields })
    },
    fetch: async (url, init) => {
      machine.calls.push({
        path: new URL(String(url)).pathname,
        method: init?.method ?? '',
        body: String(init?.body),
        headers: new Headers(init?.headers),
        at: machine.context.now?.() ?? 0,
      })
      return Response.json({ accepted: true, nextInSec: 30 })
    },
  })
  expect(exit).toBe(0)
  const endpoints = machine.calls.map((call) => {
    const value: unknown = JSON.parse(call.body)
    return value !== null && typeof value === 'object' && 'endpoint' in value
      ? value.endpoint
      : undefined
  })
  expect(endpoints.slice(0, 2)).toEqual(Array.from({ length: 2 }, () => `https://${name}:47615`))
  // 20 running beats after the route went away, then the stopping beat.
  expect(endpoints.slice(2)).toEqual(Array.from({ length: 21 }, () => null))
  expect(probe).toHaveBeenCalledTimes(22)
  expect(logs).toEqual([
    { scope: 'host', event: 'tailscale.endpoint', fields: { state: 'ours' } },
    { scope: 'host', event: 'tailscale.endpoint', fields: { state: 'absent' } },
  ])
  expect(JSON.stringify(logs)).not.toContain(name)
  expect(JSON.stringify(logs)).not.toContain('private')
})
