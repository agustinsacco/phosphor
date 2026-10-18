import { afterEach, expect, it, vi } from 'vitest'
import type { MachineView, MachinesResponse } from '@shared/control-api'
import type { ControlResult } from '@shared/ipc'
import { createHostConnection } from './connection'
import { createHostManagerState, type HostManagerPorts } from './manager-state'
import {
  closeAllHosts,
  disableHostManager,
  reconcileHostManager,
  refreshHostManager,
} from './manager-reconcile'

const drain = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
function setup() {
  vi.useFakeTimers()
  const state = createHostManagerState('user')
  const machine: MachineView = {
    id: 'host',
    label: 'Host',
    hostname: 'host',
    platform: 'linux',
    arch: 'x64',
    hostVersion: '1',
    keyFingerprint: 'key',
    enrolledAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    state: 'running',
    readiness: null,
    lanes: null,
    endpoint: 'https://test.ts.net',
  }
  const result = { ok: true as const, machines: [machine], serverTime: new Date().toISOString() }
  const machines = vi.fn<HostManagerPorts['machines']>().mockResolvedValue(result)
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
      disabled: () => {},
      changed: () => {},
      clearGrant: () => {},
    })
    return {
      ...c,
      close: () => {
        close()
        c.close()
      },
    }
  })
  const ports: HostManagerPorts = {
    user: () => state.user,
    clientId: () => null,
    resetReplacementBudget: vi.fn(),
    accountChanged: () => () => {},
    machinesChanged: () => () => {},
    machines,
    connection,
    clearGrants,
    changed,
  }
  return { state, ports, result, machines, close, changed, clearGrants, connection }
}
function pending() {
  let resolve!: (value: ControlResult<MachinesResponse>) => void
  const promise = new Promise<ControlResult<MachinesResponse>>((answer) => {
    resolve = answer
  })
  return { promise, resolve }
}

it('coalesces all overlapping refresh requests into one follow-up directory read', async () => {
  const t = setup(),
    reply = pending()
  t.machines.mockReturnValueOnce(reply.promise)
  const first = refreshHostManager(t.state, t.ports)
  await refreshHostManager(t.state, t.ports)
  await refreshHostManager(t.state, t.ports)
  expect(t.machines).toHaveBeenCalledTimes(1)
  expect(t.state.again).toBe(true)
  reply.resolve(t.result)
  await first
  await drain()
  expect(t.machines).toHaveBeenCalledTimes(2)
  expect(t.connection).toHaveBeenCalledTimes(1)
  expect(t.state.fetching).toBe(false)
  expect(t.state.again).toBe(false)
  closeAllHosts(t.state, t.ports)
})
it.each([true, false])(
  'rejects stale success and forbidden replies after a generation change: %s',
  async (ok) => {
    const t = setup(),
      reply = pending()
    t.machines.mockReturnValueOnce(reply.promise)
    const flight = refreshHostManager(t.state, t.ports)
    t.state.generation++
    reply.resolve(ok ? t.result : { ok: false, error: { code: 'forbidden', message: 'Forbidden' } })
    await flight
    expect(t.state.list).toBeNull()
    expect(t.state.disabled).toBe(false)
    expect(t.connection).not.toHaveBeenCalled()
    expect(t.clearGrants).not.toHaveBeenCalled()
  },
)
it('retains the directory and live connections after a failed read', async () => {
  const t = setup()
  await refreshHostManager(t.state, t.ports)
  const list = t.state.list
  t.machines.mockRejectedValueOnce(new Error('offline'))
  await refreshHostManager(t.state, t.ports)
  expect(t.state.list).toBe(list)
  expect(t.close).not.toHaveBeenCalled()
  expect(t.connection).toHaveBeenCalledTimes(1)
  closeAllHosts(t.state, t.ports)
})
it('disables and caches all live views, then closeAll drops directory, cache and grants', async () => {
  const t = setup()
  await refreshHostManager(t.state, t.ports)
  disableHostManager(t.state, t.ports)
  expect(t.state.disabled).toBe(true)
  expect(t.state.cached.host?.lastError).toBe('account-disabled')
  expect(t.state.connections.size).toBe(0)
  expect(t.close).toHaveBeenCalledTimes(1)
  await refreshHostManager(t.state, t.ports)
  reconcileHostManager(t.state, t.ports)
  expect(t.machines).toHaveBeenCalledTimes(1)
  expect(t.connection).toHaveBeenCalledTimes(1)
  closeAllHosts(t.state, t.ports)
  expect(t.state.cached).toEqual({})
  expect(t.state.list).toBeNull()
  expect(t.clearGrants).toHaveBeenCalledWith()
  expect(t.ports.resetReplacementBudget).not.toHaveBeenCalled()
})
it('does not restore connections or notify when a pending refresh completes after teardown', async () => {
  const t = setup(),
    reply = pending()
  t.machines.mockReturnValueOnce(reply.promise)
  const flight = refreshHostManager(t.state, t.ports)
  t.state.stopped = true
  t.state.generation++
  closeAllHosts(t.state, t.ports)
  reply.resolve(t.result)
  await flight
  await refreshHostManager(t.state, t.ports)
  reconcileHostManager(t.state, t.ports)
  expect(t.state.list).toBeNull()
  expect(t.state.cached).toEqual({})
  expect(t.connection).not.toHaveBeenCalled()
  expect(t.changed).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
