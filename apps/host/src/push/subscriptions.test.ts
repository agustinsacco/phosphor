import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPushSubscriptions, type StoredPushSubscription } from './subscriptions'

const HOST = '00000000-0000-4000-8000-000000000006'
const keys = {
  p256dh: 'BLovIndJxi9rn_Q4YZsHtnESnX2ccbijmaIDmUM5wlGXFhzoviBVcfGYlIZIhlSuhQ5bE_LcnhZ9SvnLQkh2g_M',
  auth: 'EAY5CR185BofDMFkvMZw4Q',
}
const client = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const row = (
  n: number,
  overrides: Partial<StoredPushSubscription> = {},
): StoredPushSubscription => ({
  clientId: client(n),
  owner: 'owner',
  epoch: 1,
  subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys },
  registeredAt: n,
  ...overrides,
})
let dir: string
let path: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-push-'))
  path = join(dir, 'web-push.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
const endpoints = (store: ReturnType<typeof createPushSubscriptions>) =>
  store.list().map((r) => r.subscription.endpoint.split('/').pop())

describe('Host push subscriptions', () => {
  it('persist owner-only and reload for the same enrollment only', async () => {
    const store = createPushSubscriptions({ path, hostId: HOST })
    store.subscribe(row(1))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(createPushSubscriptions({ path, hostId: HOST }).list()).toStrictEqual([row(1)])
    expect(createPushSubscriptions({ path, hostId: client(9) }).list()).toStrictEqual([])
  })
  it('keep one registration per client, and move a re-registered endpoint to its new client', () => {
    const store = createPushSubscriptions({ path, hostId: HOST })
    store.subscribe(row(1))
    store.subscribe(row(1, { subscription: { ...row(2).subscription }, registeredAt: 5 }))
    expect(store.list()).toHaveLength(1)
    expect(endpoints(store)).toStrictEqual(['2'])
    store.subscribe(row(3, { subscription: row(2).subscription }))
    expect(store.list().map((r) => r.clientId)).toStrictEqual([client(3)])
  })
  it('hold at most 20, forgetting the least recently registered device', () => {
    const store = createPushSubscriptions({ path, hostId: HOST })
    for (let n = 1; n <= 22; n++) store.subscribe(row(n))
    expect(store.list()).toHaveLength(20)
    expect(endpoints(store)).toStrictEqual(Array.from({ length: 20 }, (_, i) => String(i + 3)))
    store.subscribe(row(3, { registeredAt: 100 }))
    store.subscribe(row(30, { registeredAt: 101 }))
    expect(endpoints(store)).not.toContain('4')
    expect(endpoints(store)).toContain('3')
  })
  it("never removes another client's registration on unsubscribe", () => {
    const store = createPushSubscriptions({ path, hostId: HOST })
    store.subscribe(row(1))
    store.subscribe(row(2))
    store.unsubscribe(client(2), row(1).subscription.endpoint)
    expect(endpoints(store)).toStrictEqual(['1', '2'])
    store.unsubscribe(client(1), row(1).subscription.endpoint)
    expect(endpoints(store)).toStrictEqual(['2'])
  })
  it('drop gone endpoints, revoked clients, other owners and other epochs', () => {
    const store = createPushSubscriptions({ path, hostId: HOST })
    for (const r of [row(1), row(2), row(3, { owner: 'other' }), row(4, { epoch: 2 }), row(5)])
      store.subscribe(r)
    store.remove(row(5).subscription.endpoint)
    expect(store.retain({ owner: 'owner', epoch: 1, revokedClients: new Set([client(2)]) })).toBe(
      true,
    )
    expect(endpoints(store)).toStrictEqual(['1'])
    expect(store.retain({ owner: 'owner', epoch: 1, revokedClients: new Set() })).toBe(false)
    expect(createPushSubscriptions({ path, hostId: HOST }).list()).toStrictEqual([row(1)])
  })
  it('start empty from a corrupt, oversized or malformed file and drop invalid rows', async () => {
    await writeFile(path, '{nope', { mode: 0o600 })
    expect(createPushSubscriptions({ path, hostId: HOST }).list()).toStrictEqual([])
    const bad = { ...row(2), subscription: { endpoint: 'https://evil.example/', keys } }
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        hostId: HOST,
        subscriptions: [row(1), bad, { ...row(3), clientId: 'x' }],
      }),
    )
    expect(createPushSubscriptions({ path, hostId: HOST }).list()).toStrictEqual([row(1)])
    await writeFile(path, 'x'.repeat(200 * 1024))
    expect(createPushSubscriptions({ path, hostId: HOST }).list()).toStrictEqual([])
  })
  it('hold each registration as its own row: registering the same endpoint again is another', () => {
    const store = createPushSubscriptions({ path, hostId: HOST })
    const first = row(1)
    store.subscribe(first)
    expect(store.holds(first)).toBe(true)
    const again = row(1)
    store.subscribe(again)
    expect([store.holds(first), store.holds(again)]).toStrictEqual([false, true])
    store.unsubscribe(client(1), again.subscription.endpoint)
    expect(store.holds(again)).toBe(false)
    const kept = row(2)
    store.subscribe(kept)
    store.subscribe(row(3))
    expect(store.holds(kept)).toBe(true)
    store.retain({ owner: 'owner', epoch: 2, revokedClients: new Set() })
    expect(store.holds(kept)).toBe(false)
  })
})
