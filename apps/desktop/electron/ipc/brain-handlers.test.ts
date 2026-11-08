import { expect, it, vi } from 'vitest'
import type { BrainInvokeMap } from '@phosphor/shared/brain'
import type { BrainService, BrainApi } from '@phosphor/brain-runtime/service-types'

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
  'brain:learnPreview',
  'brain:learn',
  'brain:learningJobs',
  'brain:learningDetail',
  'brain:cancel',
  'brain:review',
  'brain:correct',
  'brain:forget',
  'brain:transcript',
] satisfies (keyof BrainInvokeMap)[]
it('registers exactly the public review/settings channels and forwards typed arguments', async () => {
  const api = Object.fromEntries(
    channels.map((channel) => [channel.slice('brain:'.length), vi.fn(async () => 'result')]),
  ) as unknown as BrainApi
  registerBrainHandlers({ api } as BrainService)
  expect([...registrations.keys()].sort()).toEqual([...channels].sort())
  const consent = { policyEpoch: 4, model: { provider: 'openai', id: 'explicit-model' } }
  await expect(registrations.get('brain:process')!({}, '/workspace', consent)).resolves.toBe(
    'result',
  )
  expect(api.process).toHaveBeenCalledWith('/workspace', consent)
  await registrations.get('brain:evidence')!({}, '/workspace', 'a'.repeat(64))
  expect(api.evidence).toHaveBeenCalledWith('/workspace', 'a'.repeat(64))
  expect(registrations.has('brain:dispose')).toBe(false)
  expect(registrations.has('brain:putVectors')).toBe(false)
})
it.each<[keyof BrainInvokeMap, unknown[]]>([
  ['brain:status', []],
  ['brain:setPrefs', [{}]],
  ['brain:download', [true]],
  ['brain:removeModel', []],
  ['brain:search', [{ query: 'Atlas' }]],
  ['brain:read', ['evidence']],
  ['brain:evidence', ['/workspace', 'a'.repeat(64)]],
  ['brain:graph', ['entity']],
  ['brain:process', ['/workspace', {}]],
  ['brain:learnPreview', [{ workspacePath: '/workspace', sessionPath: '/source' }]],
  [
    'brain:learn',
    [
      { workspacePath: '/workspace', sessionPath: '/source' },
      { policyEpoch: 1, fingerprint: 'f'.repeat(64) },
    ],
  ],
  ['brain:learningJobs', ['/workspace']],
  ['brain:learningDetail', ['job']],
  ['brain:cancel', ['job']],
  ['brain:review', ['proposal', false, {}]],
  ['brain:correct', ['claim', {}, {}]],
  ['brain:forget', [['evidence']]],
  ['brain:transcript', ['job']],
])('maps %s to its distinct backend method without changing arguments', async (channel, args) => {
  const api = Object.fromEntries(
    channels.map((name) => [name.slice('brain:'.length), vi.fn(async () => name)]),
  ) as unknown as BrainApi
  registerBrainHandlers({ api } as BrainService)
  await expect(registrations.get(channel)!({}, ...args)).resolves.toBe(channel)
  expect(api[channel.slice('brain:'.length) as keyof BrainApi]).toHaveBeenCalledWith(...args)
})
it('registers lazily and retries service acquisition after a failed first load', async () => {
  const service = { api: { status: vi.fn(async () => 'ready') } } as unknown as BrainService
  const get = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(service)
  registerBrainHandlers(get)
  expect(get).not.toHaveBeenCalled()
  const status = () => Promise.resolve().then(() => registrations.get('brain:status')!({}))
  await expect(status()).rejects.toThrow('offline')
  await expect(status()).resolves.toBe('ready')
  expect(get).toHaveBeenCalledTimes(2)
})
it('rejects oversized processing consent without even acquiring the lazy backend', () => {
  const acquire = vi.fn(async () => {
    throw new Error('Backend must not be acquired')
  })
  registerBrainHandlers(acquire)
  expect(() =>
    registrations.get('brain:process')!({}, '/workspace', { text: 'x'.repeat(256_001) }),
  ).toThrow('exceeds limit')
  expect(acquire).not.toHaveBeenCalled()
})
it('refuses oversized IPC payloads before entering the adapter', () => {
  const api = Object.fromEntries(
    channels.map((channel) => [channel.slice('brain:'.length), vi.fn()]),
  ) as unknown as BrainApi
  registerBrainHandlers({ api } as BrainService)
  expect(() => registrations.get('brain:search')!({}, { query: 'x'.repeat(256_001) })).toThrow(
    'exceeds limit',
  )
  expect(api.search).not.toHaveBeenCalled()
})
