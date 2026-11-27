import { expect, it, vi } from 'vitest'
import { createDesktopBrainOpener } from './service-opener'

it('refuses before startup, after a fence with a cached service, and after shutdown', async () => {
  let admit = false
  const construct = vi.fn(async () => 'Harbor')
  const opener = createDesktopBrainOpener(() => {
    if (!admit) throw new Error('Ownership not proved')
  }, construct)
  await expect(opener.get()).rejects.toThrow('Ownership not proved')
  expect(construct).not.toHaveBeenCalled()
  admit = true
  await expect(opener.get()).resolves.toBe('Harbor')
  admit = false
  await expect(opener.get()).rejects.toThrow('Ownership not proved')
  expect(construct).toHaveBeenCalledOnce()
  await expect(opener.close()).resolves.toBe('Harbor')
  await expect(opener.get()).rejects.toThrow('shutting down')
})
