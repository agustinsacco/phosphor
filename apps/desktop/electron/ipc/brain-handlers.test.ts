import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import { beforeEach, expect, it, vi } from 'vitest'
import type { BrainService } from '@phosphor/brain-runtime/types'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('./handle', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
}))

const { checkLane, checkPrefs, registerBrainHandlers } = await import('./brain-handlers')
const { IPC_WEB } = await import('@phosphor/shared/ipc-web')

const api = {
  entities: vi.fn(async () => 'entities'),
  recent: vi.fn(async () => 'recent'),
  status: vi.fn(async () => 'status'),
  setPrefs: vi.fn(async () => 'saved'),
  neverRead: vi.fn(async () => 'saved'),
  queue: vi.fn(async () => 'queued'),
  merge: vi.fn(async () => 'merged'),
  describe: vi.fn(async () => 'described'),
  removeName: vi.fn(async () => 'unnamed'),
  split: vi.fn(async () => 'split'),
  connections: vi.fn(async () => 'page'),
  entityMemories: vi.fn(async () => 'memories'),
  neighbourhood: vi.fn(async () => 'graph'),
  find: vi.fn(async () => 'found'),
  defrag: vi.fn(async () => 'started'),
  defragStop: vi.fn(async () => 'stopped'),
  undoRun: vi.fn(async () => 'undone'),
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

it('starts and stops Defrag, and refuses an invalid run id before undoing a run', async () => {
  await expect(call('brain:defrag')).resolves.toBe('started')
  await expect(call('brain:defragStop')).resolves.toBe('stopped')
  await expect(call('brain:undoRun', 'run-1')).resolves.toBe('undone')
  expect(api.undoRun).toHaveBeenCalledWith('run-1')
  for (const bad of ['', 7, null, 'x'.repeat(201)])
    await expect(call('brain:undoRun', bad)).rejects.toThrow()
  expect(api.undoRun).toHaveBeenCalledTimes(1)
})

it('accepts the Brain switches and reader model', async () => {
  const prefs = {
    enabled: true,
    recall: false,
    review: true,
    model: null,
    neverRead: DEFAULT_BRAIN_PREFS.neverRead,
  }
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

it('queues a lane with no title, as Read new messages sends for an untitled read', async () => {
  // An untitled read stores '' as its title, and the engine derives the title from the file.
  const lane = { sessionPath: '/s/harbor.jsonl', title: '' }
  await expect(call('brain:queue', lane)).resolves.toBe('queued')
  expect(api.queue).toHaveBeenCalledWith(lane)
  expect(() => checkLane({ sessionPath: '/s', title: 3 })).toThrow('Invalid Brain request.')
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
  await expect(call('brain:merge', 'harbor-2', 'harbor', 0)).resolves.toBe('merged')
})

it('registers extraction inspection and rejects invalid job ids', async () => {
  expect(handlers.has('brain:extraction')).toBe(true)
  for (const id of ['', null, 'x'.repeat(201)])
    await expect(call('brain:extraction', id)).rejects.toThrow('Invalid Brain request.')
})

it.each([null, 'harbor/reader', 'harbor/team/reader', `p/${'m'.repeat(198)}`])(
  'passes reader model %s through IPC',
  async (model) => {
    const prefs = {
      enabled: true,
      recall: true,
      review: true,
      model,
      neverRead: DEFAULT_BRAIN_PREFS.neverRead,
    }
    await expect(call('brain:setPrefs', prefs)).resolves.toBe('saved')
    expect(api.setPrefs).toHaveBeenLastCalledWith(prefs)
  },
)
it.each([
  '-harbor/reader',
  'harbor/read er',
  'harbor/reader\n',
  'harbor/rea\u0000der',
  'harbor/rea\u007fder',
  'harbor/rea\u0085der',
  'reader',
  '/reader',
  'harbor/',
  '',
  `p/${'m'.repeat(199)}`,
  7,
  false,
  {},
  undefined,
])('refuses invalid reader model %j at the handler', async (model) => {
  api.setPrefs.mockClear()
  await expect(
    call('brain:setPrefs', {
      enabled: true,
      recall: true,
      review: true,
      model,
      neverRead: DEFAULT_BRAIN_PREFS.neverRead,
    }),
  ).rejects.toThrow('Invalid Brain reader model')
  expect(api.setPrefs).not.toHaveBeenCalled()
})
it('registers history/reread and refuses invalid limits before calling the service', async () => {
  expect(handlers.has('brain:history')).toBe(true)
  expect(handlers.has('brain:reread')).toBe(true)
  for (const limit of [0, -1, 201, 1.5, NaN, Infinity, '10', null])
    await expect(call('brain:history', limit)).rejects.toThrow('Invalid Brain history limit.')
  for (const job of ['', null, 'x'.repeat(201)])
    await expect(call('brain:reread', job)).rejects.toThrow('Invalid Brain request.')
})

it('checks browse kind, offset, limit and sort and recent limit before reading', async () => {
  for (const kind of ['invalid', undefined, 1, {}])
    await expect(call('brain:entities', kind, 0, 20, 'connected')).rejects.toThrow('entity kind')
  for (const offset of [-1, 0.5, NaN, Infinity, '0', null, Number.MAX_SAFE_INTEGER + 1])
    await expect(call('brain:entities', null, offset, 20, 'name')).rejects.toThrow('entity offset')
  for (const limit of [0, 101, 1.5, NaN, Infinity, '20', null])
    await expect(call('brain:entities', null, 0, limit, 'recent')).rejects.toThrow('entity limit')
  for (const sort of [undefined, null, '', 'newest', 'Name', 1, {}])
    await expect(call('brain:entities', null, 0, 20, sort)).rejects.toThrow('entity sort')
  for (const limit of [0, 51, 1.5, NaN, Infinity, '10', null])
    await expect(call('brain:recent', limit)).rejects.toThrow()
  for (const sort of ['connected', 'recent', 'name']) {
    await expect(call('brain:entities', 'person', 20, 100, sort)).resolves.toBe('entities')
    expect(api.entities).toHaveBeenLastCalledWith('person', 20, 100, sort)
  }
  await expect(call('brain:entities', null, 0, 1, 'connected')).resolves.toBe('entities')
  await expect(call('brain:recent', 50)).resolves.toBe('recent')
  expect(api.recent).toHaveBeenCalledWith(50)
})

it('checks entity edits before invoking the API', async () => {
  await expect(call('brain:describe', 'harbor', '  Harbor billing system  ', 3)).resolves.toBe(
    'described',
  )
  expect(api.describe).toHaveBeenLastCalledWith('harbor', 'Harbor billing system', 3)
  for (const description of ['', '   ', 'x'.repeat(161), 4, null])
    await expect(call('brain:describe', 'harbor', description, 3)).rejects.toThrow(
      '1 to 160 characters',
    )
  await expect(call('brain:describe', 'harbor', 'Harbor', -1)).rejects.toThrow('revision')
  await expect(call('brain:describe', '', 'Harbor', 0)).rejects.toThrow('Invalid Brain request.')

  await expect(call('brain:removeName', 'kestrel', 'Harbor', 2)).resolves.toBe('unnamed')
  expect(api.removeName).toHaveBeenLastCalledWith('kestrel', 'Harbor', 2)
  for (const name of ['', 'x'.repeat(201), 3, null])
    await expect(call('brain:removeName', 'kestrel', name, 2)).rejects.toThrow('Invalid Brain')
  await expect(call('brain:removeName', 'kestrel', 'Harbor')).rejects.toThrow('revision')

  const target = { label: ' Tom Lee (vendor) ', kind: 'person' }
  await expect(call('brain:split', 'tom', ['m1', 'm2'], target, 5)).resolves.toBe('split')
  expect(api.split).toHaveBeenLastCalledWith(
    'tom',
    ['m1', 'm2'],
    { label: 'Tom Lee (vendor)', kind: 'person' },
    5,
  )
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`)
  await expect(call('brain:split', 'tom', ids(200), target, 5)).resolves.toBe('split')
  for (const memoryIds of [[], ids(201), ['m1', 'm1'], 'm1', null])
    await expect(call('brain:split', 'tom', memoryIds, target, 5)).rejects.toThrow('1 to 200')
  await expect(call('brain:split', 'tom', ['m1', ''], target, 5)).rejects.toThrow('Invalid Brain')
  for (const label of ['', '  ', 'x'.repeat(81), 7])
    await expect(call('brain:split', 'tom', ['m1'], { ...target, label }, 5)).rejects.toThrow(
      '1 to 80 characters',
    )
  await expect(
    call('brain:split', 'tom', ['m1'], { ...target, kind: 'vendor' }, 5),
  ).rejects.toThrow('entity kind')
  await expect(call('brain:split', 'tom', ['m1'], { ...target, extra: true }, 5)).rejects.toThrow(
    'Invalid Brain request.',
  )
  await expect(call('brain:split', 'tom', ['m1'], target, 1.5)).rejects.toThrow('revision')
})

it('forwards an individual lane exclusion and bounds the title settings', async () => {
  await expect(call('brain:neverRead', 'harbor-lane', true)).resolves.toBe('saved')
  expect(api.neverRead).toHaveBeenCalledWith('harbor-lane', true)
  for (const neverRead of [
    { titles: ['x'.repeat(81)], sessionIds: [] },
    { titles: Array(51).fill('Harbor'), sessionIds: [] },
    { titles: [], sessionIds: Array(5001).fill('harbor-lane') },
  ]) {
    await expect(call('brain:setPrefs', { ...DEFAULT_BRAIN_PREFS, neverRead })).rejects.toThrow(
      'Invalid Brain never-read settings.',
    )
  }
})

it('refuses invalid individual lane switches before resolving the service', async () => {
  api.neverRead.mockClear()
  for (const [sessionId, never] of [
    ['', true],
    [' ', true],
    ['x'.repeat(201), true],
    ['harbor', 1],
  ])
    await expect(call('brain:neverRead', sessionId, never)).rejects.toThrow(
      'Invalid Brain never-read lane.',
    )
  expect(api.neverRead).not.toHaveBeenCalled()
})
