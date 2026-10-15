import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  enabled: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  read: vi.fn(),
  set: vi.fn(),
}))
vi.mock('./handle', () => ({
  handle: (name: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(name, fn),
}))
vi.mock('../store', () => ({
  getPrefs: () => ({ tailscaleDiscovery: mocks.enabled }),
  setTailscaleDiscovery: mocks.set,
}))
vi.mock('../hosts/tailscale-status', () => ({ readTailscaleStatus: mocks.read }))
import { registerTailscaleHandlers } from './tailscale-handlers'
beforeEach(() => {
  mocks.enabled = false
  mocks.read.mockReset()
  mocks.set.mockReset()
  registerTailscaleHandlers()
})
it('defaults off and reads only the stored opt-in, never renderer arguments', async () => {
  mocks.read.mockResolvedValue({ code: 'ready', discovery: false, peers: [] })
  await mocks.handlers.get('hosts:tailscaleStatus')?.({}, true)
  expect(mocks.read).toHaveBeenCalledWith(false)
  mocks.enabled = true
  await mocks.handlers.get('hosts:tailscaleStatus')?.({})
  expect(mocks.read).toHaveBeenLastCalledWith(true)
})
it('validates and persists only boolean preferences', () => {
  const set = mocks.handlers.get('hosts:setTailscaleDiscovery')!
  for (const value of ['true', 1, {}, null, undefined]) expect(() => set({}, value)).toThrow()
  expect(mocks.set).not.toHaveBeenCalled()
  set({}, true)
  expect(mocks.set).toHaveBeenCalledWith(true)
  set({}, false)
  expect(mocks.set).toHaveBeenLastCalledWith(false)
})
it('suppresses a pending result when discovery is switched off', async () => {
  mocks.enabled = true
  let finish!: (value: unknown) => void
  mocks.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const result = mocks.handlers.get('hosts:tailscaleStatus')?.({})
  mocks.enabled = false
  finish({ code: 'ready', discovery: true, peers: [{ dnsName: 'private.tail123.ts.net' }] })
  expect(await result).toEqual({ code: 'ready', discovery: false, peers: [] })
})
