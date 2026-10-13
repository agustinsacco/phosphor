import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { controlFailure } from '../control/client'
import { createClientIds, cleanClients, type RemoteClients } from './client-id'
import { createGrants } from './grants'

function setup() {
  let user: string | null = randomUUID(),
    clients: RemoteClients = {},
    present = true
  const registerClient = vi.fn(async (label: unknown) => ({
    ok: true as const,
    client: { id: randomUUID(), label: typeof label === 'string' ? label : 'Viewer' },
  }))
  const ids = createClientIds({
    user: () => user,
    read: () => clients,
    write: (value) => {
      clients = value
    },
    hostname: () => 'test\u202e\nhost'.repeat(20),
    control: { registerClient },
  })
  const hostId = randomUUID()
  const reply = {
    ok: true as const,
    grant: '',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    host: { id: hostId, endpoint: 'https://test.ts.net', publicKey: '' },
  }
  const grant = vi.fn(async () => reply)
  const grants = createGrants({ clients: ids, present: () => present, control: { grant } })
  return {
    ids,
    grants,
    grant,
    reply,
    hostId,
    registerClient,
    clients: () => clients,
    user: (next: string | null) => {
      user = next
    },
    present: (next: boolean) => {
      present = next
    },
  }
}
it('registers once per user, cleans labels, reuses ids, and evicts oldest after eight', async () => {
  const t = setup()
  const [one, two] = await Promise.all([t.ids.get(), t.ids.get()])
  expect(one).toBe(two)
  expect(t.registerClient).toHaveBeenCalledTimes(1)
  expect(await t.ids.get()).toBe(one)
  expect(Object.values(t.clients())[0]?.label).toHaveLength(80)
  expect(Object.values(t.clients())[0]?.label).not.toMatch(/[\u202e\n]/)
  for (let i = 0; i < 8; i++) {
    t.user(randomUUID())
    t.ids.clear()
    await t.ids.get()
  }
  expect(Object.keys(t.clients())).toHaveLength(8)
  expect(Object.values(t.clients()).some((c) => c.clientId === one)).toBe(false)
  expect(
    cleanClients({
      [randomUUID()]: { clientId: 'invalid', label: 'Viewer' },
      invalid: { clientId: randomUUID(), label: 'Viewer' },
    }),
  ).toEqual({})
})
it('single-flights grants, caches until renewal, and clears on account change', async () => {
  const t = setup()
  await Promise.all([t.grants.grantFor(t.hostId), t.grants.grantFor(t.hostId)])
  expect(t.grant).toHaveBeenCalledTimes(1)
  await t.grants.grantFor(t.hostId)
  expect(t.grant).toHaveBeenCalledTimes(1)
  t.grants.clear()
  t.user(randomUUID())
  await t.grants.grantFor(t.hostId)
  expect(t.grant).toHaveBeenCalledTimes(2)
  expect(t.registerClient).toHaveBeenCalledTimes(2)
})
it('re-registers a revoked id once, refuses a second 404, and never retries a removed host', async () => {
  const t = setup()
  // Return signatures share the control client's validated union.
  const grant = vi
    .fn()
    .mockResolvedValueOnce(controlFailure('not-found'))
    .mockResolvedValueOnce(t.reply)
    .mockResolvedValue(controlFailure('not-found'))
  const grants = createGrants({ control: { grant }, clients: t.ids, present: () => true })
  await grants.grantFor(t.hostId)
  expect(t.registerClient).toHaveBeenCalledTimes(2)
  grants.clear(t.hostId)
  await expect(grants.grantFor(t.hostId)).rejects.toThrow('grant-refused')
  expect(t.registerClient).toHaveBeenCalledTimes(2)
  t.present(false)
  await expect(t.grants.grantFor(t.hostId)).rejects.toThrow('grant-refused')
  expect(t.registerClient).toHaveBeenCalledTimes(2)
})
it('a second refusal stops and account-disabled is not repaired with registration', async () => {
  const t = setup()
  const grant = vi.fn().mockResolvedValue(controlFailure('not-found'))
  const grants = createGrants({ control: { grant }, clients: t.ids, present: () => true })
  await expect(grants.grantFor(t.hostId)).rejects.toThrow('grant-refused')
  expect(grant).toHaveBeenCalledTimes(2)
  grant.mockResolvedValue(controlFailure('forbidden'))
  await expect(grants.grantFor(t.hostId)).rejects.toThrow('account-disabled')
  expect(t.registerClient).toHaveBeenCalledTimes(2)
})
it('rejects stale registration after sign-out without writing any identity', async () => {
  const t = setup()
  const flight = t.ids.get()
  t.user(null)
  t.ids.clear()
  await expect(flight).rejects.toThrow('signed-out')
  expect(t.clients()).toEqual({})
})
it('does not retain a grant that finishes after a host cache clear', async () => {
  const t = setup()
  let answer: ((value: typeof t.reply) => void) | undefined
  const grant = vi.fn(
    () =>
      new Promise<typeof t.reply>((resolve) => {
        answer = resolve
      }),
  )
  const grants = createGrants({ control: { grant }, clients: t.ids, present: () => true })
  const flight = grants.grantFor(t.hostId)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  grants.clear(t.hostId)
  answer?.(t.reply)
  await expect(flight).rejects.toThrow('signed-out')
})

it('invalidates the grant at exactly the renewal margin', async () => {
  const t = setup()
  let now = Date.now()
  const grants = createGrants({
    control: { grant: t.grant },
    clients: t.ids,
    present: () => true,
    now: () => now,
  })
  await grants.grantFor(t.hostId)
  now = Date.parse(t.reply.expiresAt) - 60_001
  await grants.grantFor(t.hostId)
  expect(t.grant).toHaveBeenCalledTimes(1)
  now++
  await grants.grantFor(t.hostId)
  expect(t.grant).toHaveBeenCalledTimes(2)
})

it('drops invalid client labels and non-contract stored fields', () => {
  const user = randomUUID(),
    clientId = randomUUID()
  expect(cleanClients({ [user]: { clientId, label: null } })).toEqual({})
  expect(cleanClients({ [user]: { clientId, label: 'Viewer', extra: 'discard' } })).toEqual({
    [user]: { clientId, label: 'Viewer' },
  })
})
