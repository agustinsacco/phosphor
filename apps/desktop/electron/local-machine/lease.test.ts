import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeLocalService, type FakeLocalService } from './__fixtures__/local-service'
import {
  LEASE_REFUSED,
  LOCAL_SERVICE_UNAVAILABLE,
  WorkspaceLeaseRefused,
  withWorkspaceLease,
  type WorkspaceLease,
} from './lease'

const CHECKOUT = '/Users/u/repo/.phosphor/worktrees/a'
let fake: FakeLocalService
const ports = () => ({
  service: () => ({
    hostId: fake.hostId,
    connection: fake.connection,
    repositories: [],
    lanes: [],
  }),
  ttlMs: 30_000,
})

beforeEach(() => {
  vi.useFakeTimers()
  fake = fakeLocalService()
})
afterEach(() => vi.useRealTimers())

it('holds the lease while the work runs and releases it afterwards', async () => {
  const result = await withWorkspaceLease(
    [CHECKOUT],
    async (lease) => {
      expect(lease.held()).toBe(true)
      expect([...fake.leases.values()]).toEqual([[CHECKOUT]])
      return 'removed'
    },
    ports(),
  )
  expect(result).toBe('removed')
  await vi.waitFor(() => expect(fake.leases.size).toBe(0))
  expect(fake.calls.map((c) => c.method)).toEqual(['owner.lease.take', 'owner.lease.release'])
  expect(fake.calls[0]?.params).toEqual({ paths: [CHECKOUT], ttlMs: 30_000 })
})

it('releases the lease when the work throws', async () => {
  await expect(
    withWorkspaceLease([CHECKOUT], () => Promise.reject(new Error('git failed')), ports()),
  ).rejects.toThrow('git failed')
  await vi.waitFor(() => expect(fake.leases.size).toBe(0))
})

it.each(['live-lane', 'routine', 'archive', 'busy'] as const)(
  'refuses with fixed text when the service answers %s, and runs nothing',
  async (refusal) => {
    fake.refuse = refusal
    const run = vi.fn()
    const error: unknown = await withWorkspaceLease([CHECKOUT], run, ports()).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(WorkspaceLeaseRefused)
    expect(error).toMatchObject({ refusal, path: CHECKOUT, message: LEASE_REFUSED[refusal] })
    expect(run).not.toHaveBeenCalled()
  },
)

it('refuses a live lane’s checkout and leaves the service without a lease', async () => {
  fake.lanes = [{ laneId: 'l', cwd: CHECKOUT, activity: 'working' }]
  await expect(withWorkspaceLease([CHECKOUT], vi.fn(), ports())).rejects.toThrow(
    LEASE_REFUSED['live-lane'],
  )
  expect(fake.leases.size).toBe(0)
})

it('fails closed while the service is not connected', async () => {
  const run = vi.fn()
  await expect(withWorkspaceLease([CHECKOUT], run, { service: () => undefined })).rejects.toThrow(
    LOCAL_SERVICE_UNAVAILABLE,
  )
  expect(run).not.toHaveBeenCalled()
})

it('renews every third of the TTL and reports the lease lost after a failed renewal', async () => {
  let lease: WorkspaceLease | undefined
  let finish: () => void = () => {}
  const done = withWorkspaceLease(
    [CHECKOUT],
    (l) => {
      lease = l
      return new Promise<void>((resolve) => (finish = resolve))
    },
    ports(),
  )
  await vi.waitFor(() => expect(lease).toBeDefined())
  await vi.advanceTimersByTimeAsync(10_000)
  expect(fake.calls.filter((c) => c.method === 'owner.lease.renew')).toHaveLength(1)
  expect(lease?.held()).toBe(true)
  fake.lost = true
  await vi.advanceTimersByTimeAsync(10_000)
  expect(lease?.held()).toBe(false)
  finish()
  await done
})

it('reports the lease lost once its TTL passes without an answered renewal', async () => {
  let lease: WorkspaceLease | undefined
  let finish: () => void = () => {}
  vi.mocked(fake.connection.call).mockImplementation(async (method, params) => {
    if (method === 'owner.lease.renew') return new Promise(() => {})
    fake.calls.push({ method, params })
    return {
      type: 'result',
      id: '1',
      ok: true,
      data: { leaseId: '00000000-0000-4000-8000-000000000001' },
    }
  })
  const done = withWorkspaceLease(
    [CHECKOUT],
    (l) => {
      lease = l
      return new Promise<void>((resolve) => (finish = resolve))
    },
    ports(),
  )
  await vi.waitFor(() => expect(lease).toBeDefined())
  await vi.advanceTimersByTimeAsync(29_000)
  expect(lease?.held()).toBe(true)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(lease?.held()).toBe(false)
  finish()
  await done
})
