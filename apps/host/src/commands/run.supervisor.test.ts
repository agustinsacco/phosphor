import { afterEach, beforeEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import type { ControlMachine } from '../control/__fixtures__/machine'
import { identityDirectory } from '../control/identity'
import { acquireIdentityLock } from '../control/lock'
import { createShutdown } from '../shutdown'
import { runCli } from '../cli'
import { runHost, type RunContext } from './run'
import { createRunFixture, waitForRunEvent, heartbeatBarrier } from './__fixtures__/run'

let machine: ControlMachine
let context: () => RunContext
beforeEach(async () => {
  const fixture = await createRunFixture()
  machine = fixture.machine
  context = fixture.context
})
afterEach(async () => {
  await machine.cleanup()
})

it('CLI supervisor maps missing enrollment without touching stderr before the run lock', async () => {
  const { mkdir, stat } = await import('node:fs/promises')
  const { hostLogDirectory } = await import('../machine/log')
  const { serviceExitPath } = await import('../machine/launchd')
  const path = join(hostLogDirectory(context().env, machine.root), 'launchd.err.log')
  await mkdir(hostLogDirectory(context().env, machine.root), { recursive: true, mode: 0o700 })
  await writeFile(path, 'x'.repeat(1024 * 1024 + 1))
  expect(
    await runCli(
      ['run', '--supervisor', 'launchd', '--config', machine.configPath],
      { stdout: () => {}, stderr: () => {} },
      {
        ...context(),
        home: machine.root,
        nodeVersion: process.versions.node,
        defaultResourceRoot: '/unused',
      },
    ),
  ).toBe(0)
  expect((await stat(path)).size).toBe(1024 * 1024 + 1)
  expect(
    JSON.parse(await readFile(serviceExitPath(context().env, machine.root), 'utf8')).code,
  ).toBe(69)
})
it('supervisor logs and records removal without changing foreground runs', async () => {
  await machine.enrollOld()
  const { serviceExitPath } = await import('../machine/launchd')
  const entries: unknown[] = []
  const f: RunContext = {
    ...context(),
    supervisor: 'launchd',
    home: machine.root,
    nodeVersion: process.versions.node,
    defaultResourceRoot: join(machine.root, 'resources'),
    log: (scope, message, data) => {
      entries.push({ scope, message, data })
    },
    fetch: async () => new Response(null, { status: 410 }),
  }
  expect(await runHost(f)).toBe(0)
  expect(entries).toContainEqual({ scope: 'service', message: 'stopped', data: { code: 77 } })
  expect(
    JSON.parse(await readFile(serviceExitPath(context().env, machine.root), 'utf8')).code,
  ).toBe(77)
  await writeFile(machine.configPath, '{}')
  expect(await runHost(f)).toBe(0)
  expect(
    JSON.parse(await readFile(serviceExitPath(context().env, machine.root), 'utf8')).code,
  ).toBe(78)
})

it('supervisor keeps a clean first signal at exit 0 without a permanent record', async () => {
  await machine.enrollOld()
  const { serviceExitPath } = await import('../machine/launchd')
  const exits: number[] = []
  const heartbeat = heartbeatBarrier()
  const shutdown = createShutdown({
    exit: (code) => {
      exits.push(code)
    },
    stderr: () => {},
    stopProbes: () => {},
  })
  const f: RunContext = {
    ...context(),
    home: machine.root,
    nodeVersion: process.versions.node,
    defaultResourceRoot: join(machine.root, 'resources'),
    supervisor: 'launchd',
    attach: shutdown.attach,
    wait: (ms, signal) => setTimeout(ms, undefined, { signal }),
    fetch: heartbeat.fetch,
  }
  const run = runHost(f)
  try {
    await waitForRunEvent(heartbeat.running, run)
    await shutdown.signal('SIGTERM')
  } finally {
    machine.abort.abort()
    await run
  }
  expect(await run).toBe(0)
  expect(exits).toEqual([0])
  expect(heartbeat.states).toEqual(['running', 'stopping'])
  await expect(readFile(serviceExitPath(context().env, machine.root))).rejects.toThrow()
})

it('a supervised run that loses the run lock leaves stderr and the exit record unchanged', async () => {
  await machine.enrollOld()
  const { mkdir } = await import('node:fs/promises')
  const { hostLogDirectory } = await import('../machine/log')
  const { launchdExit, serviceExitPath } = await import('../machine/launchd')
  const path = join(hostLogDirectory(context().env, machine.root), 'launchd.err.log')
  await mkdir(hostLogDirectory(context().env, machine.root), { recursive: true, mode: 0o700 })
  const original = Buffer.alloc(1024 * 1024 + 1, 'x')
  await writeFile(path, original)
  await launchdExit(78, context().env, machine.root, 1000)
  const record = await readFile(serviceExitPath(context().env, machine.root))
  const release = await acquireIdentityLock(
    identityDirectory(machine.configPath),
    machine.context.uid,
    undefined,
    '.run-lock',
  )
  try {
    expect(
      await runHost({
        ...context(),
        home: machine.root,
        supervisor: 'launchd',
        stderrIdentity: () => statSync(path),
      }),
    ).toBe(75)
    expect((await readFile(path)).equals(original)).toBe(true)
    expect(await readFile(serviceExitPath(context().env, machine.root))).toEqual(record)
  } finally {
    await release()
  }
})
it.each([false, true])(
  'a lock holder prepares stderr and continues after a compaction error: %s',
  async (throws) => {
    await machine.enrollOld()
    const { mkdir } = await import('node:fs/promises')
    const { hostLogDirectory } = await import('../machine/log')
    const { launchdExit, serviceExitPath } = await import('../machine/launchd')
    const path = join(hostLogDirectory(context().env, machine.root), 'launchd.err.log')
    await mkdir(hostLogDirectory(context().env, machine.root), { recursive: true, mode: 0o700 })
    const original = 'a'.repeat(1024 * 1024 + 1) + 'b'.repeat(256 * 1024)
    await writeFile(path, original)
    await launchdExit(78, context().env, machine.root, 1000)
    const entries: unknown[] = []
    let started = false
    expect(
      await runHost({
        ...context(),
        home: machine.root,
        supervisor: 'launchd',
        stderrIdentity: () => {
          if (throws) throw Object.assign(new Error('private path'), { code: 'EIO' })
          return statSync(path)
        },
        log: (scope, message, data) => entries.push({ scope, message, data }),
        fetch: async () => {
          started = true
          await expect(readFile(serviceExitPath(context().env, machine.root))).rejects.toThrow()
          expect(await readFile(path, 'utf8')).toBe(throws ? original : 'b'.repeat(256 * 1024))
          return new Response(null, { status: 410 })
        },
      }),
    ).toBe(0)
    expect(started).toBe(true)
    if (throws)
      expect(entries).toContainEqual({
        scope: 'service',
        message: 'err_log_skipped',
        data: { reason: 'EIO' },
      })
    expect(JSON.stringify(entries)).not.toContain('private path')
  },
)
