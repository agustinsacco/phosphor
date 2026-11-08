import { afterEach, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { join } from 'node:path'
import { PiRpcClient, type PiSpawnOptions } from './rpc-client'
import { SessionRegistry } from './session-registry'

vi.mock('electron', () => {
  throw new Error('The portable registry imported Electron')
})
const owners: SessionRegistry[] = []
const cwd = import.meta.dirname
const options = {
  binaryPath: process.execPath,
  prefixArgs: [join(cwd, '__fixtures__', 'fake-pi.cjs')],
}
function owner(isClosing = () => false) {
  const createClient = vi.fn(
    (spawn: PiSpawnOptions) => new PiRpcClient(spawn, { log: vi.fn(), isClosing }),
  )
  const registry = new SessionRegistry({
    createClient,
    assertCanStart: () => {
      if (isClosing()) throw new Error('Owner is closing')
    },
  })
  owners.push(registry)
  return { registry, createClient }
}
afterEach(async () => {
  await Promise.all(owners.splice(0).map((registry) => registry.disposeAll()))
})

it('checks admission before creating a client and keeps owners independent', async () => {
  let closing = true
  const first = owner(() => closing)
  const second = owner()
  expect(() => first.registry.create(cwd, options)).toThrow('Owner is closing')
  expect(first.createClient).not.toHaveBeenCalled()
  expect(first.registry.list()).toEqual([])
  const other = second.registry.create(cwd, options)
  closing = false
  const local = first.registry.create(cwd, options)
  expect(first.registry.get(other.sessionId)).toBeUndefined()
  expect(second.registry.get(local.sessionId)).toBeUndefined()
  expect(first.createClient).toHaveBeenCalledWith({ ...options, cwd })
  await first.registry.disposeAll()
  expect(second.registry.get(other.sessionId)).toBe(other)
  expect(other.client.alive).toBe(true)
})

it('preserves event ordering, live metadata and ownership through concurrent disposal', async () => {
  const { registry } = owner()
  const created = vi.fn((session) => {
    expect(registry.get(session.sessionId)).toBe(session)
    expect(session.client.alive).toBe(true)
  })
  const disposed = vi.fn(({ sessionId }) => expect(registry.get(sessionId)).toBeUndefined())
  registry.on('created', created)
  registry.on('disposed', disposed)
  const live = registry.create(cwd, options)
  expect(created).toHaveBeenCalledExactlyOnceWith(live)
  expect((await live.client.request({ type: 'get_state' })).success).toBe(true)
  expect(registry.list()).toEqual([
    {
      sessionId: live.sessionId,
      workspacePath: cwd,
      pid: live.client.pid,
      diskPath: '/fake/session.jsonl',
    },
  ])
  const first = registry.dispose(live.sessionId)
  const second = registry.dispose(live.sessionId)
  expect(registry.get(live.sessionId)).toBe(live)
  await Promise.all([first, second])
  expect(live.client.alive).toBe(false)
  expect(registry.list()).toEqual([])
  expect(disposed).toHaveBeenCalledExactlyOnceWith({ sessionId: live.sessionId })
  await registry.dispose(live.sessionId)
  expect(disposed).toHaveBeenCalledTimes(1)
})

it('retains crashed sessions for the client to inspect until explicitly disposed', async () => {
  const { registry } = owner()
  const live = registry.create(cwd, {
    binaryPath: process.execPath,
    prefixArgs: ['-e', 'process.exit(3)', '--'],
  })
  const [exit] = await once(live.client, 'exit')
  expect(exit).toMatchObject({ code: 3, expected: false })
  expect(registry.get(live.sessionId)).toBe(live)
  expect(registry.list()).toHaveLength(1)
  await registry.dispose(live.sessionId)
  expect(registry.list()).toEqual([])
})

it.each(['spawn', 'observer'])(
  'disposes owned allocation when %s throws synchronously',
  async (failure) => {
    const { registry, createClient } = owner()
    if (failure === 'observer')
      registry.on('created', () => {
        throw new Error('observer failed')
      })
    const disposed = once(registry, 'disposed')
    expect(() =>
      registry.create(cwd, failure === 'spawn' ? { binaryPath: '\0' } : options),
    ).toThrow()
    // A caller never received the handle, but the owner must still drain it.
    await disposed
    expect(registry.list()).toEqual([])
    expect(createClient.mock.results[0]!.value.alive).toBe(false)
  },
)

it('keeps the synchronous signal-shutdown path', async () => {
  const { registry } = owner()
  const live = registry.create(cwd, options)
  await live.client.request({ type: 'get_state' })
  const exited = once(live.client, 'exit')
  registry.killAllSync()
  expect(registry.list()).toEqual([])
  const [exit] = await exited
  expect(exit.expected).toBe(true)
})
