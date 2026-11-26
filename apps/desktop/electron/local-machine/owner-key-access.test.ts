import { expect, it, vi } from 'vitest'
import type { OwnerKeyResult } from '../daemon/owner-key'
import { createOwnerKeyAccess } from './owner-key-access'

vi.mock('electron', () => ({ app: {} }))
vi.mock('../account', () => ({ cipher: vi.fn() }))

it('shares the first request, remembers a refusal, and only tries protected storage again on retry', async () => {
  let finish: (result: OwnerKeyResult) => void = () => {}
  const pending = new Promise<OwnerKeyResult>((resolve) => {
    finish = resolve
  })
  const load = vi.fn(() => pending)
  const access = createOwnerKeyAccess(load)
  const status: Array<ReturnType<typeof access.status>> = []
  access.onChange(() => status.push(access.status()))
  expect(load).not.toHaveBeenCalled()
  const first = access.get()
  expect(access.get()).toBe(first)
  expect(access.retry()).toBe(first)
  finish({ ok: false, reason: 'denied' })
  await expect(first).resolves.toEqual({ ok: false, reason: 'denied' })
  expect(access.get()).toBe(first)
  expect(load).toHaveBeenCalledOnce()
  const success: OwnerKeyResult = {
    ok: true,
    created: false,
    key: { id: 'test', publicKey: 'test', label: 'test', sign: () => new Uint8Array() },
  }
  load.mockResolvedValueOnce(success)
  const retried = access.retry()
  expect(access.get()).toBe(retried)
  await expect(retried).resolves.toBe(success)
  expect(access.get()).toBe(retried)
  expect(status).toEqual(['checking', 'unavailable', 'checking', undefined])
  expect(load).toHaveBeenCalledTimes(2)
})
