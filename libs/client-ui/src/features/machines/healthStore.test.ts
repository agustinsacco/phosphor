// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { lastLocalSubscriptionAuth } from '@/stores/localSubscriptionAuth'
import { startHealthCheck } from './healthStore'

afterEach(() => {
  vi.unstubAllGlobals()
})

it("leaves its fresh provider read for This Mac's Providers card and Settings → Accounts", async () => {
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
    if (channel === 'pi:subscriptionAuth') return [{ id: 'a', name: 'A', status: 'ready' }]
    throw new Error(`not read here: ${channel}`)
  })
  vi.stubGlobal('phosphor', { invoke })
  await startHealthCheck()
  expect(invoke).toHaveBeenCalledWith('pi:subscriptionAuth')
  invoke.mockClear()
  expect(await lastLocalSubscriptionAuth()).toEqual([{ id: 'a', name: 'A', status: 'ready' }])
  expect(invoke).not.toHaveBeenCalled()
})
