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
  expect(registrations.has('brain:dispose')).toBe(false)
  expect(registrations.has('brain:putVectors')).toBe(false)
})
it('refuses oversized IPC payloads before entering the adapter', () => {
  const ui = Object.fromEntries(channels.map((channel) => [channel, vi.fn()])) as unknown as BrainUI
  registerBrainHandlers({ ui } as BrainService)
  expect(() => registrations.get('brain:search')!({}, { query: 'x'.repeat(256_001) })).toThrow(
    'exceeds limit',
  )
  expect(ui['brain:search']).not.toHaveBeenCalled()
})
