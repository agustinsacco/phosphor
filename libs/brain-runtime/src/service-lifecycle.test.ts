import { expect, it, vi } from 'vitest'
import { createBrainLifecycle } from './service-lifecycle'

it('retains cleanup ports and retries disposal when an owned process cannot stop once', async () => {
  const resources = {
    revoke: vi.fn(),
    detach: vi.fn(),
    stopEmbeddings: vi.fn(),
    stopIndexing: vi.fn(),
    stopProcessor: vi
      .fn()
      .mockRejectedValueOnce(new Error('owned stop failed'))
      .mockResolvedValue(undefined),
    purge: vi.fn(async () => {}),
    closeBridge: vi.fn(async () => {}),
    closeStore: vi.fn(async () => {}),
  }
  const lifecycle = createBrainLifecycle(resources)
  await expect(lifecycle.dispose()).rejects.toThrow('owned stop failed')
  expect(lifecycle.isClosed()).toBe(true)
  expect(resources.closeBridge).not.toHaveBeenCalled()
  expect(resources.closeStore).not.toHaveBeenCalled()
  await expect(lifecycle.serialize(async () => 'unsafe')).rejects.toThrow('disposed')
  await lifecycle.dispose()
  expect(resources.stopProcessor).toHaveBeenCalledTimes(2)
  expect(resources.purge).toHaveBeenCalledOnce()
  expect(resources.closeBridge).toHaveBeenCalledOnce()
  expect(resources.closeStore).toHaveBeenCalledOnce()
  expect(resources.detach).toHaveBeenCalledOnce()
  await lifecycle.dispose()
  expect(resources.stopProcessor).toHaveBeenCalledTimes(2)
})
