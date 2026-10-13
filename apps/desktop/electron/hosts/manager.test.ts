import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { MachineView } from '@shared/control-api'
import { controlFailure } from '../control/client'
import { createHostConnection } from './connection'
import { createHostManager } from './manager'

const drain = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
function machine(): MachineView {
  return {
    id: randomUUID(),
    label: 'Test Host',
    hostname: 'test-host',
    platform: 'linux',
    arch: 'x64',
    hostVersion: '1.0.0',
    keyFingerprint: '0123 4567 89ab cdef',
    enrolledAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    state: 'running',
    readiness: null,
    lanes: null,
    endpoint: 'https://test.ts.net',
  }
}
function setup(count = 1) {
  vi.useFakeTimers()
  let user: string | null = randomUUID(),
    list = Array.from({ length: count }, machine)
  let accountChanged = () => {},
    machinesChanged = () => {}
  const machines = vi.fn(async () => ({
    ok: true as const,
    machines: list,
    serverTime: new Date().toISOString(),
  }))
  const close = vi.fn(),
    changed = vi.fn(),
    clearGrants = vi.fn()
  const connection = vi.fn((hostId: string, endpoint: string | null) => {
    const c = createHostConnection({
      hostId,
      endpoint,
      socket: async () => {
        throw new Error('offline')
      },
      grant: async () => {
        throw new Error('offline')
      },
      changed: () => {},
      clearGrant: () => {},
    })
    return {
      ...c,
      snapshot: () => ({ ...c.snapshot(), state: 'ready' as const }),
      close: () => {
        close()
        c.close()
      },
    }
  })
  const manager = createHostManager({
    user: () => user,
    machines,
    connection,
    clearGrants,
    changed,
    accountChanged: (cb) => {
      accountChanged = cb
      return () => {}
    },
    machinesChanged: (cb) => {
      machinesChanged = cb
      return () => {}
    },
  })
  return {
    manager,
    machines,
    connection,
    close,
    changed,
    clearGrants,
    list: () => list,
    setList: (next: MachineView[]) => {
      list = next
      machinesChanged()
    },
    account: (next: string | null) => {
      user = next
      accountChanged()
    },
    signal: () => machinesChanged(),
  }
}
it('follows down, removal, endpoint, account changes and sign-out', async () => {
  const t = setup()
  await drain()
  expect(t.connection).toHaveBeenCalledTimes(1)
  const m = t.list()[0]
  if (!m) throw new Error('No machine')
  t.setList([{ ...m, state: 'stopping' }])
  await drain()
  expect(t.close).toHaveBeenCalledTimes(1)
  expect(t.manager.snapshot()[m.id]?.state).toBe('reconnecting')
  t.setList([{ ...m, endpoint: 'https://new.ts.net' }])
  await drain()
  expect(t.connection).toHaveBeenCalledTimes(2)
  t.setList([{ ...m, endpoint: 'https://another.ts.net' }])
  await drain()
  expect(t.connection).toHaveBeenCalledTimes(3)
  expect(t.close).toHaveBeenCalledTimes(2)
  t.setList([])
  await drain()
  expect(t.manager.snapshot()).toEqual({})
  t.setList([m])
  await drain()
  t.account(randomUUID())
  await drain()
  expect(t.clearGrants).toHaveBeenCalledWith()
  t.account(null)
  await drain()
  expect(t.manager.snapshot()).toEqual({})
  t.manager.stop()
})
it('caps active connections at 32, ignores no-address for capacity, and debounces pushes', async () => {
  const t = setup(33)
  await drain()
  expect(t.connection).toHaveBeenCalledTimes(32)
  await vi.advanceTimersByTimeAsync(250)
  expect(t.changed).toHaveBeenCalledTimes(1)
  const noAddress = machine()
  t.setList([{ ...noAddress, endpoint: null }, ...t.list()])
  await drain()
  expect(t.manager.snapshot()[noAddress.id]?.state).toBe('no-address')
  expect(t.connection).toHaveBeenCalledTimes(32)
  t.manager.stop()
})
it('judges a silent Host down on the local clock without directory refetch', async () => {
  const t = setup()
  await drain()
  await vi.advanceTimersByTimeAsync(95_000)
  expect(t.close).toHaveBeenCalledTimes(1)
  expect(t.machines).toHaveBeenCalledTimes(1)
  t.manager.stop()
})
it('coalesces directory refreshes and ignores a stale account response', async () => {
  const t = setup()
  await drain()
  let answer: ((value: Awaited<ReturnType<typeof t.machines>>) => void) | undefined
  t.machines.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve
      }),
  )
  t.signal()
  t.signal()
  t.signal()
  t.account(null)
  answer?.({ ok: true, machines: t.list(), serverTime: new Date().toISOString() })
  await drain()
  expect(t.machines).toHaveBeenCalledTimes(2)
  expect(t.manager.present(t.list()[0]?.id ?? '')).toBe(false)
  expect(t.manager.snapshot()).toEqual({})
  t.manager.stop()
})
it('403 stops all connections and retains only a safe account-disabled reason', async () => {
  const t = setup()
  await drain()
  t.manager.disabled()
  expect(t.close).toHaveBeenCalledTimes(1)
  expect(Object.values(t.manager.snapshot())[0]?.lastError).toBe('account-disabled')
  t.signal()
  await drain()
  expect(t.machines).toHaveBeenCalledTimes(1)
  expect(controlFailure('forbidden').ok).toBe(false)
  t.manager.stop()
})
