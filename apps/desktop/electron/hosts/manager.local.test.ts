import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MachineView } from '@shared/control-api'
import type { HostConnectionSnapshot } from '@phosphor/host-client/connection'
import type { createHostConnection } from './connection'
import { createHostManager } from './manager'

/**
 * This machine's own service sits beside the directory's Hosts: no sign-in,
 * no directory entry, no grant and no share of the 32-socket cap.
 */
type Connection = ReturnType<typeof createHostConnection>

const drain = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}

function fakeConnection(lanes = 0) {
  const view: HostConnectionSnapshot = {
    state: 'ready',
    connectionToken: randomUUID(),
    capabilities: ['sessions.read'],
    repositories: [],
    lanes: Array.from({ length: lanes }, () => ({
      laneId: randomUUID(),
      control: { fence: 1, controller: null },
    })) as unknown as HostConnectionSnapshot['lanes'],
  }
  return { snapshot: () => structuredClone(view), close: vi.fn() } as unknown as Connection & {
    close: ReturnType<typeof vi.fn>
  }
}

function machine(): MachineView {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    label: 'Remote',
    hostname: 'remote',
    platform: 'linux',
    arch: 'x64',
    hostVersion: '1.0.0',
    keyFingerprint: '0123 4567 89ab cdef',
    enrolledAt: now,
    lastSeenAt: now,
    state: 'running',
    readiness: null,
    lanes: null,
    endpoint: 'https://remote.ts.net',
  }
}

function setup(options: { user?: string | null; machines?: number } = {}) {
  let user = options.user === undefined ? randomUUID() : options.user
  let accountChanged = () => {}
  const list = Array.from({ length: options.machines ?? 0 }, machine)
  const remote = vi.fn((_hostId: string, _endpoint: string | null) => fakeConnection())
  const machines = vi.fn(async () => ({
    ok: true as const,
    machines: list,
    serverTime: new Date().toISOString(),
  }))
  const manager = createHostManager({
    user: () => user,
    clientId: () => null,
    resetReplacementBudget: () => {},
    accountChanged: (cb) => {
      accountChanged = cb
      return () => {}
    },
    machinesChanged: () => () => {},
    machines,
    connection: remote,
    clearGrants: () => {},
    changed: () => {},
  })
  return {
    manager,
    list,
    remote,
    machines,
    account(next: string | null) {
      user = next
      accountChanged()
    },
  }
}

const LOCAL = '6f1c3a52-7d1e-4c9b-8a55-0b1e2c3d4e5f'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('serves the local slot signed out, marked local, beside no directory', async () => {
  const t = setup({ user: null })
  const local = fakeConnection(1)
  t.manager.setLocal({ hostId: LOCAL, label: 'This Mac', create: () => local })
  await drain()
  expect(t.machines).not.toHaveBeenCalled()
  expect(t.manager.connection(LOCAL)).toBe(local)
  expect(t.manager.present(LOCAL)).toBe(true)
  expect(t.manager.label(LOCAL)).toBe('This Mac')
  const view = t.manager.snapshot()[LOCAL]
  expect(view).toMatchObject({ state: 'ready', local: true })
  expect(view?.lanes[0]?.control).toEqual({ fence: 1, controller: null })
})

it('keeps the local connection through sign-in, sign-out, account changes and a disabled account', async () => {
  const t = setup()
  const local = fakeConnection()
  t.manager.setLocal({ hostId: LOCAL, label: 'This Mac', create: () => local })
  await drain()
  t.account(randomUUID())
  t.account(null)
  t.manager.disabled()
  await drain()
  expect(local.close).not.toHaveBeenCalled()
  expect(t.manager.connection(LOCAL)).toBe(local)
  expect(t.manager.snapshot()[LOCAL]?.local).toBe(true)
})

it('does not count the local connection against the 32-socket cap', async () => {
  const t = setup({ machines: 40 })
  t.manager.setLocal({ hostId: LOCAL, label: 'This Mac', create: () => fakeConnection() })
  await drain()
  expect(t.remote).toHaveBeenCalledTimes(32)
  const views = t.manager.snapshot()
  expect(Object.values(views).filter((v) => v.local)).toHaveLength(1)
  expect(Object.values(views).filter((v) => v.state === 'ready')).toHaveLength(33)
})

it('a reconnect of the local id replaces only the local connection, without the directory', async () => {
  const t = setup({ machines: 1 })
  await drain()
  const first = fakeConnection()
  const second = fakeConnection()
  const create = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
  t.manager.setLocal({ hostId: LOCAL, label: 'This Mac', create })
  const reads = t.machines.mock.calls.length
  await t.manager.reconnect(LOCAL)
  expect(first.close).toHaveBeenCalledOnce()
  expect(t.manager.connection(LOCAL)).toBe(second)
  expect(t.machines.mock.calls.length).toBe(reads)
  expect(t.remote).toHaveBeenCalledTimes(1)
})

it('clearing the slot or stopping the manager closes the local connection', async () => {
  const t = setup()
  const local = fakeConnection()
  t.manager.setLocal({ hostId: LOCAL, label: 'This Mac', create: () => local })
  t.manager.setLocal(null)
  expect(local.close).toHaveBeenCalledOnce()
  expect(t.manager.connection(LOCAL)).toBeUndefined()
  expect(t.manager.present(LOCAL)).toBe(false)
  expect(t.manager.snapshot()[LOCAL]).toBeUndefined()
  const next = fakeConnection()
  t.manager.setLocal({ hostId: LOCAL, label: 'This Mac', create: () => next })
  t.manager.stop()
  expect(next.close).toHaveBeenCalledOnce()
  const late = vi.fn(() => fakeConnection())
  t.manager.setLocal({ hostId: LOCAL, label: 'This Mac', create: late })
  expect(late).not.toHaveBeenCalled()
})

it('holds first-launch admission until the owner identifies itself; never opens TCP for the alias', async () => {
  const t = setup({ machines: 2 })
  const self = t.list[0]!.id,
    other = t.list[1]!.id
  const local = fakeConnection(1)
  t.manager.directory(undefined)
  t.manager.setLocal({ hostId: LOCAL, label: 'This Mac', create: () => local })
  await drain()
  expect(t.remote).not.toHaveBeenCalled()
  expect(t.manager.snapshot()[other]).toMatchObject({
    state: 'connecting',
    lastError: 'waiting-local-service',
  })
  t.manager.directory(self)
  expect(t.remote.mock.calls.map(([id]) => id)).toEqual([other])
  expect(t.manager.snapshot()[LOCAL]).toMatchObject({ enrolledHostId: self })
  expect(t.manager.snapshot()[self]).toBeUndefined()
  expect(t.manager.present(self)).toBe(false)
  t.manager.directory(other)
  expect(t.manager.snapshot()[other]).toBeUndefined()
  expect(t.remote.mock.calls.map(([id]) => id)).toEqual([other, self])
  expect(local.close).not.toHaveBeenCalled()
})

it('uses the remembered alias before the local socket is ready, admitting only other machines', async () => {
  const t = setup({ machines: 2 })
  const self = t.list[0]!.id,
    other = t.list[1]!.id
  t.manager.directory(self)
  await drain()
  expect(t.remote.mock.calls.map(([id]) => id)).toEqual([other])
  expect(t.manager.present(self)).toBe(false)
})
