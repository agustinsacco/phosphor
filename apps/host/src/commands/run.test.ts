import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_ROUTES, HOST_HEADERS, type Readiness } from '@phosphor/shared/control-api'
import { controlMachine, type ControlMachine, oldId } from '../control/__fixtures__/machine'
import { identityDirectory } from '../control/identity'
import { acquireIdentityLock } from '../control/lock'
import type { RunContext } from './run'
import { runHost } from './run'
import { createShutdown } from '../shutdown'
import { createHeartbeat } from '../control/heartbeat'
import { runCli } from '../cli'

const readiness: Readiness = { pi: 'ok', claude: 'ok', tailscale: 'ok' }
let machine: ControlMachine
beforeEach(async () => {
  machine = await controlMachine()
})
afterEach(async () => {
  await machine.cleanup()
})
const context = (): RunContext => ({
  ...machine.context,
  env: {},
  heartbeat: { readiness: async () => readiness, random: () => 0 },
})
describe('phosphor run', () => {
  it('dispatches CLI run through one shutdown attachment and sends stopping on SIGTERM', async () => {
    await machine.enrollOld()
    const exits: number[] = []
    const shutdown = createShutdown({
      exit: (code) => {
        exits.push(code)
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
    await shutdown.signal('SIGTERM')
    expect(await run).toBe(0)
    expect(states).toEqual(['running', 'stopping'])
    expect(exits).toEqual([0])
    expect(attached).toBe(1)
    expect(detached).toBe(1)
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
