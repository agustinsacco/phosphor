import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ handlers: new Map<string, () => unknown>(), read: vi.fn() }))
vi.mock('./handle', () => ({
  handle: (name: string, fn: () => unknown) => mocks.handlers.set(name, fn),
}))
vi.mock('../hosts/tailscale-status', () => ({ readTailscaleStatus: mocks.read }))
import { registerTailscaleHandlers } from './tailscale-handlers'
it('registers only the read-only readiness check', async () => {
  registerTailscaleHandlers()
  mocks.read.mockResolvedValue({ code: 'ready' })
  expect(await mocks.handlers.get('hosts:tailscaleStatus')?.()).toEqual({ code: 'ready' })
  expect(mocks.read).toHaveBeenCalledWith()
  expect([...mocks.handlers.keys()]).toEqual(['hosts:tailscaleStatus'])
})
