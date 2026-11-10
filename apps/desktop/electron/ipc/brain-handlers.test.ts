import { beforeEach, expect, it, vi } from 'vitest'
import type { BrainService } from '@phosphor/brain-runtime/types'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('./handle', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
}))

const { checkKeep, checkLane, checkPrefs, registerBrainHandlers } = await import('./brain-handlers')

const api = {
  status: vi.fn(async () => 'status'),
  setPrefs: vi.fn(async () => 'saved'),
  queue: vi.fn(async () => 'queued'),
  review: vi.fn(async () => 'reviewed'),
}
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

beforeEach(() => {
  handlers.clear()
  registerBrainHandlers(async () => ({ api }) as unknown as BrainService)
})

it('registers every Brain channel', () => {
  expect([...handlers.keys()].sort()).toEqual([
    'brain:cancel',
    'brain:download',
    'brain:extraction',
    'brain:forget',
    'brain:knowledge',
    'brain:memory',
    'brain:proposal',
    'brain:queue',
    'brain:removeModel',
    'brain:review',
    'brain:setPrefs',
    'brain:status',
  ])
})

it('accepts exactly the three Brain switches', async () => {
  const prefs = { enabled: true, recall: false, review: true }
  expect(checkPrefs(prefs)).toEqual(prefs)
  await expect(call('brain:setPrefs', prefs)).resolves.toBe('saved')
  for (const bad of [
    null,
    { enabled: true },
    { ...prefs, retentionDays: 30 },
    { ...prefs, recall: 1 },
  ])
    expect(() => checkPrefs(bad)).toThrow('Invalid Brain settings.')
})

it('passes a lane reference and refuses empty or oversized fields', async () => {
  const lane = { sessionPath: '/s/harbor.jsonl', title: 'Harbor billing' }
  await expect(call('brain:queue', { ...lane, extra: 1 })).resolves.toBe('queued')
  expect(api.queue).toHaveBeenCalledWith(lane)
  expect(() => checkLane({ sessionPath: '', title: 'x' })).toThrow('Invalid Brain request.')
  expect(() => checkLane({ sessionPath: '/s', title: 'x'.repeat(501) })).toThrow()
})

it('checks review selections and revisions before the service sees them', async () => {
  expect(checkKeep(null)).toBeNull()
  expect(checkKeep([0, 2])).toEqual([0, 2])
  for (const bad of [[1, 1], [-1], [1.5], [200], 'all'])
    expect(() => checkKeep(bad)).toThrow('Invalid review selection.')
  await expect(call('brain:review', 'job-1', [0], 3)).resolves.toBe('reviewed')
  expect(api.review).toHaveBeenCalledWith('job-1', [0], 3)
  await expect(call('brain:review', 'job-1', [0], -1)).rejects.toThrow('Invalid Brain revision.')
})

it('registers extraction inspection and rejects invalid job ids', async () => {
  expect(handlers.has('brain:extraction')).toBe(true)
  for (const id of ['', null, 'x'.repeat(201)])
    await expect(call('brain:extraction', id)).rejects.toThrow('Invalid Brain request.')
})
