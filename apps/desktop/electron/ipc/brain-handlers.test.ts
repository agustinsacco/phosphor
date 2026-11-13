import { beforeEach, expect, it, vi } from 'vitest'
import type { BrainService } from '@phosphor/brain-runtime/types'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('./handle', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
}))

const { checkDecision, checkLane, checkPrefs, registerBrainHandlers } =
  await import('./brain-handlers')
const { IPC_WEB } = await import('@phosphor/shared/ipc-web')

const api = {
  status: vi.fn(async () => 'status'),
  setPrefs: vi.fn(async () => 'saved'),
  queue: vi.fn(async () => 'queued'),
  review: vi.fn(async () => 'reviewed'),
  merge: vi.fn(async () => 'merged'),
  connections: vi.fn(async () => 'page'),
  entityMemories: vi.fn(async () => 'memories'),
  neighbourhood: vi.fn(async () => 'graph'),
  find: vi.fn(async () => 'found'),
}
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

beforeEach(() => {
  handlers.clear()
  registerBrainHandlers(async () => ({ api }) as unknown as BrainService)
})

it('registers every Brain channel in the shared contract', () => {
  const brain = Object.keys(IPC_WEB)
    .filter((channel) => channel.startsWith('brain:'))
    .sort()
  expect([...handlers.keys()].sort()).toEqual(brain)
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

it('checks review decisions and revisions before the service sees them', async () => {
  const decision = { memories: [0, 2], identities: { n1: 'new', n2: 'harbor' }, groups: [0] }
  expect(checkDecision(null)).toBeNull()
  expect(checkDecision(decision)).toEqual(decision)
  for (const bad of [
    { ...decision, memories: [1, 1] },
    { ...decision, memories: [-1] },
    { ...decision, groups: [1.5] },
    { ...decision, identities: { n1: 3 } },
    { ...decision, identities: { n1: '' } },
    { ...decision, extra: true },
    { memories: [0], groups: [] },
    'all',
  ])
    expect(() => checkDecision(bad)).toThrow('Invalid review selection.')
  await expect(call('brain:review', 'job-1', decision, 3)).resolves.toBe('reviewed')
  expect(api.review).toHaveBeenCalledWith('job-1', decision, 3)
  await expect(call('brain:review', 'job-1', null, -1)).rejects.toThrow('Invalid Brain revision.')
})

it('checks explorer arguments: predicates, directions, hops, filters and cursors', async () => {
  await expect(call('brain:connections', 'harbor', 'owns', 'in', null)).resolves.toBe('page')
  await expect(call('brain:connections', 'harbor', 'likes', 'in', null)).rejects.toThrow()
  await expect(call('brain:connections', 'harbor', 'owns', 'up', null)).rejects.toThrow()
  await expect(call('brain:connections', 'harbor', 'owns', 'out', 7)).rejects.toThrow()
  await expect(call('brain:neighbourhood', 'harbor', 2)).resolves.toBe('graph')
  await expect(call('brain:neighbourhood', 'harbor', 3)).rejects.toThrow()
  const filter = { types: ['risk'], states: ['active', 'disputed'], sessionId: 'lane-1' }
  await expect(call('brain:entityMemories', 'harbor', filter, 'c1')).resolves.toBe('memories')
  expect(api.entityMemories).toHaveBeenCalledWith('harbor', filter, 'c1')
  for (const bad of [{ types: ['gossip'] }, { states: ['gone'] }, { order: 'new' }, null])
    await expect(call('brain:entityMemories', 'harbor', bad, null)).rejects.toThrow()
  await expect(call('brain:find', 'Harbor', 8)).resolves.toBe('found')
  await expect(call('brain:find', 'Harbor', 500)).rejects.toThrow()
})

it('refuses merging an entity into itself', async () => {
  await expect(call('brain:merge', 'harbor', 'harbor')).rejects.toThrow('different entity')
  await expect(call('brain:merge', 'harbor-2', 'harbor')).resolves.toBe('merged')
})

it('registers extraction inspection and rejects invalid job ids', async () => {
  expect(handlers.has('brain:extraction')).toBe(true)
  for (const id of ['', null, 'x'.repeat(201)])
    await expect(call('brain:extraction', id)).rejects.toThrow('Invalid Brain request.')
})
