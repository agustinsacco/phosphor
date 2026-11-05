// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { lastLocalSubscriptionAuth, readLocalSubscriptionAuth } from './localSubscriptionAuth'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('shares a read still in flight between two opens', async () => {
  const pending: ((rows: unknown) => void)[] = []
  const invoke = vi.fn(() => new Promise((resolve) => pending.push(resolve)))
  vi.stubGlobal('phosphor', { invoke })
  const first = lastLocalSubscriptionAuth()
  const second = lastLocalSubscriptionAuth()
  for (const finish of pending) finish([{ id: 'anthropic', name: 'Claude', status: 'ready' }])
  expect(await second).toEqual(await first)
  expect(invoke).toHaveBeenCalledOnce()
})

it('keeps the last answer when a later read fails', async () => {
  const invoke = vi.fn(async () => {
    throw new Error('pi is busy')
  })
  vi.stubGlobal('phosphor', { invoke })
  await expect(readLocalSubscriptionAuth()).rejects.toThrow('pi is busy')
  expect(await lastLocalSubscriptionAuth()).toEqual([
    { id: 'anthropic', name: 'Claude', status: 'ready' },
  ])
  expect(invoke).toHaveBeenCalledOnce()
})
