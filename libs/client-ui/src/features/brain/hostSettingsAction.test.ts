import { expect, expectTypeOf, it, vi } from 'vitest'
import { runHostSettingsAction } from './hostSettingsAction'
import type { HOST_BRAIN_HINT, useHostBrainSelection } from './useHostBrain'

it('has a user-facing hint for every Host selection that is not ready', () => {
  expectTypeOf<Exclude<ReturnType<typeof useHostBrainSelection>['state'], 'ready'>>().toEqualTypeOf<
    keyof typeof HOST_BRAIN_HINT
  >()
})

it('acknowledges a title rule only after the Host saves it', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined)
  const failure = vi.fn()
  const denied = vi.fn().mockRejectedValue(new Error('stale revision'))
  await expect(runHostSettingsAction(denied, refresh, failure)).resolves.toBe(false)
  expect(refresh).not.toHaveBeenCalled()
  expect(failure).toHaveBeenCalledOnce()
  await expect(runHostSettingsAction(async () => undefined, refresh, failure)).resolves.toBe(true)
  expect(refresh).toHaveBeenCalledOnce()
})
