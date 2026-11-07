import { expect, it, vi } from 'vitest'
import { DEFAULT_LANE_PREFS, DEFAULT_WORKTREE_PREFS } from '@phosphor/shared/models'
import { BRANCH_PREFIX_MAX, createBrowserPreferences } from './preferences'

const LANES_KEY = 'phosphor.web.lanes.v1'
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: vi.fn((key: string) => items.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void items.set(key, value)),
  }
}

it('stores lane and branch prefs, normalized and allowlisted, and reads them back', () => {
  const storage = memoryStorage()
  const prefs = createBrowserPreferences(storage)
  prefs.lanes({ ...DEFAULT_LANE_PREFS, markers: 'off', prStatus: false, injected: 'x' } as never)
  prefs.worktrees({ auto: false, branchPrefix: 'me/' })
  const stored = JSON.parse(storage.items.get(LANES_KEY)!)
  expect(stored.lanes).toEqual({ ...DEFAULT_LANE_PREFS, markers: 'off', prStatus: false })
  expect(stored.worktrees).toEqual({ auto: false, branchPrefix: 'me/' })
  const reopened = createBrowserPreferences(storage).get()
  expect(reopened.lanes).toMatchObject({ markers: 'off', prStatus: false })
  expect(reopened.lanes).not.toHaveProperty('injected')
  expect(reopened.worktrees).toEqual({ auto: false, branchPrefix: 'me/' })
})

it('refuses malformed or oversized lane and branch prefs', () => {
  const prefs = createBrowserPreferences(memoryStorage())
  expect(() => prefs.lanes(null as never)).toThrow('Invalid lane preferences.')
  for (const value of [
    { auto: 'yes', branchPrefix: 'a/' },
    { auto: true, branchPrefix: 'x'.repeat(BRANCH_PREFIX_MAX + 1) },
    { auto: true, branchPrefix: 'a\nb' },
    { auto: true },
  ])
    expect(() => prefs.worktrees(value as never)).toThrow('Invalid branch preferences.')
  expect(prefs.get().worktrees).toEqual(DEFAULT_WORKTREE_PREFS)
})

it('ignores stored lane prefs that are too large or not a record, keeping defaults', () => {
  for (const text of ['x'.repeat(4096), '[]', '{"worktrees":{"auto":1}}', 'not json']) {
    const prefs = createBrowserPreferences(memoryStorage({ [LANES_KEY]: text })).get()
    expect(prefs.lanes).toEqual(DEFAULT_LANE_PREFS)
    expect(prefs.worktrees).toEqual(DEFAULT_WORKTREE_PREFS)
  }
})

const SIDEBAR_KEY = 'phosphor.web.sidebar.v1'
const LANE = 'host:11111111-1111-4111-8111-111111111111/lane:22222222-2222-4222-8222-222222222222'
const FOLDER = 'host:11111111-1111-4111-8111-111111111111/repo:0123456789abcdef'

const USER = '33333333-3333-4333-8333-333333333333'
/** Preferences once `owner` is signed in: owner-scoped records are withheld until then. */
async function signedIn(storage: ReturnType<typeof memoryStorage>, owner = USER) {
  const prefs = createBrowserPreferences(storage)
  await prefs.adoptOwner(owner)
  return prefs
}

it('keeps Host lane order and Host folder collapse, Host keys only, and reads them back', async () => {
  const storage = memoryStorage()
  const prefs = await signedIn(storage)
  await prefs.sessionOrder([LANE, '/Users/me/repo/s1.jsonl', LANE])
  await prefs.collapsedWorkspaces([FOLDER, '/Users/me/repo'])
  expect(prefs.get()).toMatchObject({ sessionOrder: [LANE], collapsedWorkspaces: [FOLDER] })
  expect(JSON.parse(storage.items.get(SIDEBAR_KEY)!)).toEqual({
    sessionOrder: [LANE],
    collapsedWorkspaces: [FOLDER],
  })
  expect((await signedIn(storage)).get()).toMatchObject({
    sessionOrder: [LANE],
    collapsedWorkspaces: [FOLDER],
  })
})

it('drops malformed and oversized sidebar entries, on write and on read', async () => {
  const storage = memoryStorage()
  await signedIn(storage)
  storage.items.set(
    SIDEBAR_KEY,
    JSON.stringify({
      sessionOrder: [LANE, 42, `host:${'x'.repeat(600)}`, 'host:a\u0000b'],
      collapsedWorkspaces: 'nope',
    }),
  )
  const prefs = await signedIn(storage)
  expect(prefs.get()).toMatchObject({ sessionOrder: [LANE], collapsedWorkspaces: [] })
  await expect(prefs.sessionOrder('x' as never)).rejects.toThrow('Invalid sidebar preferences.')
  await prefs.collapsedWorkspaces(Array.from({ length: 2000 }, (_, i) => `${FOLDER}${i}`))
  expect(prefs.get().collapsedWorkspaces).toHaveLength(500)
  storage.items.set(SIDEBAR_KEY, 'not json')
  expect((await signedIn(storage)).get()).toMatchObject({
    sessionOrder: [],
    collapsedWorkspaces: [],
  })
})

it('withholds the sidebar until the owner is known, and clears it for another owner', async () => {
  const storage = memoryStorage()
  const prefs = await signedIn(storage)
  await prefs.sessionOrder([LANE])
  await prefs.collapsedWorkspaces([FOLDER])
  expect(createBrowserPreferences(storage).get()).toMatchObject({
    sessionOrder: [],
    collapsedWorkspaces: [],
  })
  const other = await signedIn(storage, '44444444-4444-4444-8444-444444444444')
  expect(other.get()).toMatchObject({ sessionOrder: [], collapsedWorkspaces: [] })
  expect(JSON.parse(storage.items.get(SIDEBAR_KEY)!)).toEqual({
    sessionOrder: [],
    collapsedWorkspaces: [],
  })
  expect((await signedIn(storage)).get()).toMatchObject({ sessionOrder: [] })
})
