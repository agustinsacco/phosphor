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
