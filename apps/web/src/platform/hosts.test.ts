import { expect, it, vi } from 'vitest'
import type { MachineView } from '@phosphor/shared/control-api'
import { createBrowserHosts } from './hosts'
import type { BrowserControl } from './control'

const id = '11111111-1111-4111-8111-111111111111'

it('does not call a Host down from a directory that went stale while the phone slept', async () => {
  let clock = Date.parse('2026-10-20T10:00:00Z')
  const machine = {
    id,
    endpoint: 'https://fixture.tail.ts.net:47615',
    label: 'Fixture',
    keyFingerprint: 'fixture',
    enrolledAt: new Date(clock).toISOString(),
    lastSeenAt: new Date(clock).toISOString(),
    state: 'running',
  } as MachineView
  let serverTime = new Date(clock).toISOString()
  const control = {
    session: () => ({ clientId: 'client' }),
    generation: () => 1,
    // The connection stays mid-connect: only the directory decides here.
    grant: () => new Promise(() => {}),
    machines: async () => ({ ok: true, machines: [structuredClone(machine)], serverTime }),
  } as unknown as BrowserControl
  const hosts = createBrowserHosts({
    control,
    socket: vi.fn(),
    changed: () => {},
    routinesChanged: () => {},
    attention: () => {},
    now: () => clock,
  })
  try {
    await hosts.refresh()
    const connection = hosts.connection(id)
    expect(connection).toBeDefined()
    // Ten minutes locked. The 5s liveness clock fires before the resume refresh lands.
    clock += 10 * 60_000
    hosts.reconcile()
    expect(hosts.connection(id)).toBe(connection)
    expect(hosts.snapshot()[id]?.state).toBe('connecting')
    // A fresh directory that still shows no heartbeat does mean the Host is down.
    serverTime = new Date(clock).toISOString()
    await hosts.refresh()
    expect(hosts.connection(id)).toBeUndefined()
    expect(hosts.snapshot()[id]?.state).toBe('down')
  } finally {
    hosts.dispose()
  }
})

it('requests Brain rights only for the selected Host and forgets them with the cookie generation', async () => {
  const clock = Date.parse('2026-10-20T10:00:00Z')
  const other = '22222222-2222-4222-8222-222222222222'
  const machine = {
    id,
    endpoint: null,
    label: 'Harbor',
    keyFingerprint: 'Harbor',
    enrolledAt: new Date(clock).toISOString(),
  } as MachineView
  const machineList = [machine, { ...machine, id: other, label: 'Ledger' }]
  const grant = vi.fn(async (_hostId: string, _rights?: readonly string[]) => {
    throw Error('offline')
  })
  const control = {
    session: () => ({ clientId: 'harbor' }),
    generation: () => 1,
    grant,
    machines: async () => ({
      ok: true,
      machines: machineList,
      serverTime: new Date(clock).toISOString(),
    }),
  } as unknown as BrowserControl
  const hosts = createBrowserHosts({
    control,
    changed: () => {},
    routinesChanged: () => {},
    attention: () => {},
    now: () => clock,
  })
  try {
    await hosts.refresh()
    hosts.setBrainAccess(id, ['read', 'control'])
    await expect(hosts.grantFor(id)).rejects.toThrow('offline')
    await expect(hosts.grantFor(other)).rejects.toThrow('offline')
    expect(grant.mock.calls).toEqual([[id, ['read', 'control']], [other]])
    hosts.clear()
    await hosts.refresh()
    await expect(hosts.grantFor(id)).rejects.toThrow('offline')
    expect(grant).toHaveBeenLastCalledWith(id)
  } finally {
    hosts.dispose()
  }
})

it('refuses a directory with duplicate or more than 32 Hosts and keeps no entries from it', async () => {
  const clock = Date.parse('2026-10-20T10:00:00Z')
  const machine = {
    id,
    endpoint: null,
    label: 'Kestrel',
    keyFingerprint: 'Kestrel',
    enrolledAt: new Date(clock).toISOString(),
  } as MachineView
  const hostId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  let machines: MachineView[] = [machine, { ...machine }]
  const control = {
    session: () => ({ clientId: 'kestrel' }),
    generation: () => 1,
    grant: () => new Promise(() => {}),
    machines: async () => ({ ok: true, machines, serverTime: new Date(clock).toISOString() }),
  } as unknown as BrowserControl
  const hosts = createBrowserHosts({
    control,
    changed: () => {},
    routinesChanged: () => {},
    attention: () => {},
    now: () => clock,
  })
  const refused = {
    ok: false,
    error: {
      code: 'unavailable',
      message: 'Invalid or oversized machine directory (maximum 32 Hosts).',
    },
  }
  try {
    expect(await hosts.refresh()).toEqual(refused)
    expect(hosts.directoryReady()).toBe(false)
    expect(hosts.present(id)).toBe(false)
    machines = Array.from({ length: 33 }, (_, n) => ({ ...machine, id: hostId(n) }))
    expect(await hosts.refresh()).toEqual(refused)
    expect(hosts.present(hostId(0))).toBe(false)
    machines = machines.slice(0, 32)
    expect((await hosts.refresh()).ok).toBe(true)
    expect(hosts.directoryReady()).toBe(true)
    expect(hosts.present(hostId(31))).toBe(true)
  } finally {
    hosts.dispose()
  }
})
