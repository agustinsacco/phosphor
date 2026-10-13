import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { GrantIssueResponse, MachineView } from '@shared/control-api'
import type { FrameSocket, LaneSummary } from '@shared/host-protocol'
import { createClientIds, type RemoteClients } from './client-id'
import { createGrants } from './grants'
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
function setup(
  count = 1,
  options: {
    user?: string
    clientId?: string
    lanes?: LaneSummary[]
    grant?: (hostId: string) => Promise<GrantIssueResponse>
    socket?: () => Promise<FrameSocket>
    clearGrants?: (hostId?: string) => void
    resetReplacementBudget?: () => void
  } = {},
) {
  vi.useFakeTimers()
  let user: string | null = options.user ?? randomUUID(),
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
    clearGrants = vi.fn(options.clearGrants),
    resetReplacementBudget = vi.fn(options.resetReplacementBudget)
  const connection = vi.fn((hostId: string, endpoint: string | null) => {
    const c = createHostConnection({
      hostId,
      endpoint,
      socket: async () => {
        if (options.socket) return options.socket()
        throw new Error('offline')
      },
      grant: async () => {
        if (options.grant) return options.grant(hostId)
        throw new Error('offline')
      },
      disabled: () => manager.disabled(),
      changed: () => {},
      clearGrant: () => {},
    })
    return {
      ...c,
      snapshot: () => ({ ...c.snapshot(), state: 'ready' as const, lanes: options.lanes ?? [] }),
      close: () => {
        close()
        c.close()
      },
    }
  })
  const manager = createHostManager({
    user: () => user,
    clientId: () => options.clientId ?? null,
    resetReplacementBudget,
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
    resetReplacementBudget,
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

it('projects controllers without client or user ids for live and cached down Hosts', async () => {
  const user = randomUUID(),
    clientId = randomUUID(),
    otherId = randomUUID()
  const summary: LaneSummary = {
    laneId: randomUUID(),
    repositoryId: '0123456789abcdef',
    cwd: '/fictional',
    title: null,
    branch: null,
    worktree: false,
    model: null,
    activity: 'idle',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attention: 0,
    read: 0,
    control: { fence: 1, controller: null },
  }
  const t = setup(1, {
    user,
    clientId,
    lanes: [
      { ...summary, control: { fence: 2, controller: { clientId, label: 'Me', connected: true } } },
      {
        ...summary,
        laneId: randomUUID(),
        control: { fence: 3, controller: { clientId: otherId, label: 'Other', connected: false } },
      },
      summary,
    ],
  })
  await drain()
  const m = t.list()[0]
  if (!m) throw new Error('No machine')
  for (const down of [false, true]) {
    if (down) {
      t.setList([{ ...m, state: 'stopping' }])
      await drain()
    }
    const view = t.manager.snapshot()
    for (const secret of [user, clientId, otherId])
      expect(JSON.stringify(view)).not.toContain(secret)
    expect(view[m.id]?.lanes.map((lane) => lane.control)).toEqual([
      { fence: 2, controller: { label: 'Me', connected: true, self: true } },
      { fence: 3, controller: { label: 'Other', connected: false, self: false } },
      { fence: 1, controller: null },
    ])
  }
  t.manager.stop()
})

function registrationManager(recovery = false) {
  const user = randomUUID()
  let currentUser: string | null = user,
    stored: RemoteClients = {}
  const registerClient = vi.fn().mockImplementation(async (label: string) => ({
    ok: true,
    client: { id: randomUUID(), label },
  }))
  const clients = createClientIds({
    user: () => currentUser,
    read: () => stored,
    write: (value) => {
      stored = value
    },
    hostname: () => 'test',
    control: { registerClient },
  })
  if (recovery) stored[user] = { clientId: randomUUID(), label: 'Old' }
  const grant = vi.fn().mockResolvedValue(controlFailure('not-found'))
  const grants = createGrants({
    control: { grant },
    clients,
    present: (id) => t.manager.present(id),
  })
  const t = setup(2, {
    user,
    grant: (id) => grants.grantFor(id),
    clearGrants: (id) => grants.clear(id),
    resetReplacementBudget: clients.resetReplacementBudget,
  })
  return {
    ...t,
    user,
    clients,
    grants,
    grant,
    registerClient,
    account: (next: string | null) => {
      currentUser = next
      t.account(next)
    },
  }
}

it.each([false, true])(
  'registration 403 disables every connection, including recovery: %s',
  async (recovery) => {
    const t = registrationManager(recovery)
    t.registerClient.mockResolvedValue(controlFailure('forbidden'))
    await drain()
    expect(t.close).toHaveBeenCalledTimes(2)
    expect(Object.values(t.manager.snapshot()).map((v) => v.lastError)).toEqual([
      'account-disabled',
      'account-disabled',
    ])
    expect(t.registerClient).toHaveBeenCalledTimes(1)
    t.account(t.user)
    t.signal()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.connection).toHaveBeenCalledTimes(2)
    t.manager.stop()
  },
)

it('retains the replacement budget through 403, cache clears, directory changes and stop', async () => {
  const t = registrationManager(true)
  await drain()
  expect(t.registerClient).toHaveBeenCalledTimes(1)
  t.grants.clear()
  t.grant.mockResolvedValue(controlFailure('forbidden'))
  await expect(t.grants.grantFor(t.list()[0]?.id ?? '')).rejects.toThrow('account-disabled')
  t.manager.disabled()
  t.account(t.user)
  t.signal()
  await drain()
  t.grants.clear(t.list()[0]?.id)
  t.grant.mockResolvedValue(controlFailure('not-found'))
  await expect(t.grants.grantFor(t.list()[0]?.id ?? '')).rejects.toThrow('grant-refused')
  expect(await t.clients.replace()).toBe(false)
  t.manager.stop()
  expect(await t.clients.replace()).toBe(false)
  expect(t.registerClient).toHaveBeenCalledTimes(1)
  expect(t.resetReplacementBudget).not.toHaveBeenCalled()
})

it('resets the replacement budget only on sign-out or a different account', async () => {
  const t = registrationManager(true)
  await drain()
  expect(await t.clients.replace()).toBe(false)
  t.account(null)
  await drain()
  t.account(t.user)
  await drain()
  expect(t.registerClient).toHaveBeenCalledTimes(2)
  expect(await t.clients.replace()).toBe(false)
  t.account(randomUUID())
  await drain()
  expect(t.resetReplacementBudget).toHaveBeenCalledTimes(3)
  t.manager.stop()
})

it('stop clears every connection and timer even when transport close throws', async () => {
  const transportClose = vi.fn(() => {
    throw new Error('close failed')
  })
  const t = setup(2, {
    grant: async (id) => ({
      grant: '',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      host: { id, publicKey: '', endpoint: 'https://test.ts.net' },
    }),
    socket: async () => ({
      close: transportClose,
      send: () => {},
      onMessage: () => {},
      onClose: () => {},
      isOpen: () => true,
      bufferedBytes: () => 0,
    }),
  })
  await drain()
  expect(() => t.manager.stop()).not.toThrow()
  expect(transportClose).toHaveBeenCalledTimes(2)
  expect(t.manager.snapshot()).toEqual({})
  expect(vi.getTimerCount()).toBe(0)
})
