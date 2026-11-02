import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createClientIds } from './client-id'
import { cleanConfigureHosts, createConfigureHosts, type ConfigureHosts } from './configure-hosts'
import { createGrants } from './grants'

function setup() {
  let user: string | null = randomUUID()
  let stored: ConfigureHosts = {}
  const hostId = randomUUID()
  const reply = {
    ok: true as const,
    grant: '',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    host: { id: hostId, endpoint: 'https://test.ts.net', publicKey: '' },
  }
  const grant = vi.fn(async () => reply)
  const clientId = randomUUID()
  const clients = createClientIds({
    user: () => user,
    read: () => (user ? { [user]: { clientId, label: 'Viewer' } } : {}),
    write: () => {},
    hostname: () => 'test',
    control: { registerClient: vi.fn() },
  })
  // A fresh pair per call stands in for a Desktop restart over the same store.
  const launch = () =>
    createGrants({
      control: { grant },
      clients,
      present: () => true,
      configured: createConfigureHosts({
        user: () => user,
        read: () => stored,
        write: (value) => {
          stored = value
        },
      }),
    })
  return {
    hostId,
    grant,
    clientId,
    launch,
    stored: () => stored,
    wipe: () => {
      stored = {}
    },
    user: (next: string | null) => {
      user = next
    },
  }
}

it('remembers settings access across a restart and a full grant clear', async () => {
  const t = setup()
  const first = t.launch()
  first.configure(t.hostId)
  await first.grantFor(t.hostId)
  expect(t.grant).toHaveBeenLastCalledWith(t.hostId, t.clientId, true)
  first.clear()
  await first.grantFor(t.hostId)
  expect(t.grant).toHaveBeenLastCalledWith(t.hostId, t.clientId, true)
  await t.launch().grantFor(t.hostId)
  expect(t.grant).toHaveBeenLastCalledWith(t.hostId, t.clientId, true)
})

it('keeps the opt-in to its account and forgets it on rollback or wipe', async () => {
  const t = setup()
  const grants = t.launch()
  grants.configure(t.hostId)
  t.user(randomUUID())
  grants.clear()
  await grants.grantFor(t.hostId)
  expect(t.grant).toHaveBeenLastCalledWith(t.hostId, t.clientId)
  t.user(Object.keys(t.stored())[0] ?? null)
  grants.configure(t.hostId, false)
  expect(t.stored()).toEqual({})
  await grants.grantFor(t.hostId)
  expect(t.grant).toHaveBeenLastCalledWith(t.hostId, t.clientId)
  grants.configure(t.hostId)
  t.wipe()
  grants.clear()
  await grants.grantFor(t.hostId)
  expect(t.grant).toHaveBeenLastCalledWith(t.hostId, t.clientId)
})

it('refuses to remember access while signed out, but a rollback still succeeds', () => {
  const t = setup()
  const grants = t.launch()
  grants.configure(t.hostId)
  t.wipe()
  t.user(null)
  expect(() => grants.configure(t.hostId)).toThrow('signed-out')
  expect(() => grants.configure(t.hostId, false)).not.toThrow()
  expect(t.stored()).toEqual({})
})

it('drops invalid ids and caps hosts per account and accounts overall', () => {
  const user = randomUUID()
  const host = randomUUID()
  expect(cleanConfigureHosts(null)).toEqual({})
  expect(cleanConfigureHosts([host])).toEqual({})
  expect(cleanConfigureHosts({ [user]: [host, host, 'bad', 7], bad: [host] })).toEqual({
    [user]: [host],
  })
  const many = Array.from({ length: 70 }, () => randomUUID())
  expect(cleanConfigureHosts({ [user]: many })[user]).toEqual(many.slice(-64))
  const users = Array.from({ length: 10 }, () => randomUUID())
  const kept = cleanConfigureHosts(Object.fromEntries(users.map((u) => [u, [host]])))
  expect(Object.keys(kept)).toEqual(users.slice(-8))
})
