import { expect, it, vi } from 'vitest'
import type { BrainInvokeMap } from '@phosphor/shared/brain'
import type { BrainService, BrainUI } from '../brain/service-types'

const registrations = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./handle', () => ({
  handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
    registrations.set(channel, handler),
}))
const { registerBrainHandlers } = await import('./brain-handlers')
const channels = [
  'brain:status',
  'brain:setPrefs',
  'brain:download',
  'brain:removeModel',
  'brain:search',
  'brain:read',
  'brain:evidence',
  'brain:graph',
  'brain:process',
  'brain:cancel',
  'brain:review',
  'brain:correct',
  'brain:forget',
  'brain:transcript',
] satisfies (keyof BrainInvokeMap)[]
it('registers exactly the public review/settings channels and forwards typed arguments', async () => {
  const ui = Object.fromEntries(
    channels.map((channel) => [channel, vi.fn(async () => 'result')]),
  ) as unknown as BrainUI
  registerBrainHandlers({ ui } as BrainService)
  expect([...registrations.keys()].sort()).toEqual([...channels].sort())
  const consent = { policyEpoch: 4, model: { provider: 'openai', id: 'explicit-model' } }
  await expect(registrations.get('brain:process')!({}, '/workspace', consent)).resolves.toBe(
    'result',
  )
  expect(ui['brain:process']).toHaveBeenCalledWith('/workspace', consent)
  await registrations.get('brain:evidence')!({}, '/workspace', 'a'.repeat(64))
  expect(ui['brain:evidence']).toHaveBeenCalledWith('/workspace', 'a'.repeat(64))
  expect(registrations.has('brain:dispose')).toBe(false)
  expect(registrations.has('brain:putVectors')).toBe(false)
})
it('registers lazily and retries service acquisition after a failed first load', async () => {
  const service = { ui: { 'brain:status': vi.fn(async () => 'ready') } } as unknown as BrainService
  const get = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(service)
  registerBrainHandlers(get)
  expect(get).not.toHaveBeenCalled()
  const status = () => Promise.resolve().then(() => registrations.get('brain:status')!({}))
  await expect(status()).rejects.toThrow('offline')
  await expect(status()).resolves.toBe('ready')
  expect(get).toHaveBeenCalledTimes(2)
})
it('refuses oversized IPC payloads before entering the adapter', () => {
  const ui = Object.fromEntries(channels.map((channel) => [channel, vi.fn()])) as unknown as BrainUI
  registerBrainHandlers({ ui } as BrainService)
  expect(() => registrations.get('brain:search')!({}, { query: 'x'.repeat(256_001) })).toThrow(
    'exceeds limit',
  )
  expect(ui['brain:search']).not.toHaveBeenCalled()
})
