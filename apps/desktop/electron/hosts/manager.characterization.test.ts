import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { MachineView, MachinesResponse } from '@shared/control-api'
import type { ControlResult } from '@shared/ipc'
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
    label: 'Host',
    hostname: 'host',
    platform: 'linux',
    arch: 'x64',
    hostVersion: '1.0.0',
    keyFingerprint: 'key',
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
  let user: string | null = 'first',
    list = Array.from({ length: count }, machine)
  let accountChanged = () => {},
    machinesChanged = () => {}
  const events: string[] = []
  const machines = vi.fn<() => Promise<ControlResult<MachinesResponse>>>(async () => ({
    ok: true,
    machines: list,
    serverTime: new Date().toISOString(),
  }))
  const resetReplacementBudget = vi.fn(),
    clearGrants = vi.fn(),
    changed = vi.fn()
  const connection = vi.fn((hostId: string, endpoint: string | null) => {
    events.push(`open:${hostId}`)
    const c = createHostConnection({
      hostId,
      endpoint,
      socket: async () => {
        throw new Error('offline')
      },
      grant: async () => {
        throw new Error('offline')
      },
      disabled: () => {},
      changed: () => {},
      clearGrant: () => {},
    })
    return {
      ...c,
      close: () => {
        events.push(`close:${hostId}`)
        c.close()
      },
    }
  })
  const offAccount = vi.fn(),
    offMachines = vi.fn()
  const manager = createHostManager({
    user: () => user,
    clientId: () => null,
    resetReplacementBudget,
    machines,
    connection,
    clearGrants,
    changed,
    accountChanged: (cb) => {
      accountChanged = cb
      return offAccount
    },
    machinesChanged: (cb) => {
      machinesChanged = cb
      return offMachines
    },
  })
  return {
    manager,
    machines,
    connection,
    events,
    resetReplacementBudget,
    clearGrants,
    changed,
    offAccount,
    offMachines,
    list: () => list,
    setList: (next: MachineView[]) => {
      list = next
      machinesChanged()
    },
    signal: () => machinesChanged(),
    account: (next: string | null) => {
      user = next
      accountChanged()
    },
  }
}

it('caps sockets at 32 and keeps the 250ms push debounce', async () => {
  const t = setup(33)
  await drain()
  expect(t.connection).toHaveBeenCalledTimes(32)
  t.manager.changed()
  await vi.advanceTimersByTimeAsync(249)
  expect(t.changed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(t.changed).toHaveBeenCalledTimes(1)
  t.manager.stop()
})
it('rejects a pending directory reply after an account switch', async () => {
  const t = setup()
  await drain()
  let resolve: ((result: ControlResult<MachinesResponse>) => void) | undefined
  t.machines.mockImplementationOnce(
    () =>
      new Promise((answer) => {
        resolve = answer
      }),
  )
  t.signal()
  t.account(null)
  resolve?.({ ok: true, machines: t.list(), serverTime: new Date().toISOString() })
  await drain()
  expect(t.manager.snapshot()).toEqual({})
  expect(t.connection).toHaveBeenCalledTimes(1)
  t.manager.stop()
})
it('closes endpoint and identity replacements before opening the next socket', async () => {
  const t = setup()
  await drain()
  let m = t.list()[0]!
  for (const change of [
    { endpoint: 'https://new.ts.net' },
    { keyFingerprint: 'new-key' },
    { enrolledAt: new Date(Date.now() + 1).toISOString() },
  ]) {
    t.events.length = 0
    m = { ...m, ...change }
    t.setList([m])
    await drain()
    expect(t.events).toEqual([`close:${m.id}`, `open:${m.id}`])
    expect(t.clearGrants).toHaveBeenCalledWith(m.id)
  }
  t.manager.stop()
})
it('retains a down cached view and its token until the machine is removed', async () => {
  const t = setup()
  await drain()
  const m = t.list()[0]!,
    before = t.manager.snapshot()[m.id]!
  t.setList([{ ...m, state: 'stopping' }])
  await drain()
  expect(t.manager.snapshot()[m.id]).toEqual({ ...before, state: 'down' })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(t.connection).toHaveBeenCalledTimes(1)
  t.setList([])
  await drain()
  expect(t.manager.snapshot()).toEqual({})
  t.manager.stop()
})
it('disables every connection on a forbidden directory reply until the account changes', async () => {
  const t = setup(2)
  await drain()
  t.machines.mockResolvedValueOnce({
    ok: false,
    error: { code: 'forbidden', message: 'Forbidden' },
  })
  t.signal()
  await drain()
  expect(Object.values(t.manager.snapshot()).map((v) => v.lastError)).toEqual([
    'account-disabled',
    'account-disabled',
  ])
  const calls = t.machines.mock.calls.length
  t.signal()
  t.account('first')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(t.machines).toHaveBeenCalledTimes(calls)
  t.account('second')
  await drain()
  expect(t.connection).toHaveBeenCalledTimes(4)
  t.manager.stop()
})
it('resets the replacement budget only on account transitions, never disable or stop', async () => {
  const t = setup()
  await drain()
  t.signal()
  t.account('first')
  await drain()
  t.manager.disabled()
  t.account('first')
  expect(t.resetReplacementBudget).not.toHaveBeenCalled()
  t.account('second')
  t.account(null)
  expect(t.resetReplacementBudget).toHaveBeenCalledTimes(2)
  t.manager.stop()
  expect(t.resetReplacementBudget).toHaveBeenCalledTimes(2)
})
