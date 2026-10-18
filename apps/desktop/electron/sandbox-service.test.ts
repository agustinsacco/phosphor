import { beforeEach, expect, it, vi } from 'vitest'

const effects = vi.hoisted(() => ({
  order: [] as string[],
  live: vi.fn(),
  plan: vi.fn(),
  resolve: vi.fn(),
  rename: vi.fn(),
  trash: vi.fn(),
  move: vi.fn(),
  repair: vi.fn(),
  trashTranscript: vi.fn(),
  stored: vi.fn(),
  recent: vi.fn(),
  real: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/data' },
  shell: { trashItem: effects.trash },
}))
vi.mock('node:fs/promises', () => ({ rename: effects.rename }))
vi.mock('./registry', () => ({ registry: { list: effects.live } }))
vi.mock('./sandbox', () => ({
  planSandboxRename: effects.plan,
  resolveSandboxFolder: effects.resolve,
  sandboxCwds: (path: string) => [path, path + '/lane'],
}))
vi.mock('./pi/pi-paths', () => ({
  sessionDirForCwd: (cwd: string) => {
    effects.order.push('pi:' + cwd)
    return '/pi' + cwd
  },
  claudeProjectDirForCwd: (cwd: string) => '/cli' + cwd,
}))
vi.mock('./sandbox-transcripts', () => ({
  moveIfPresent: effects.move,
  repointTranscripts: effects.repair,
  trashIfPresent: effects.trashTranscript,
}))
vi.mock('./store', () => ({
  realPathOrNull: effects.real,
  repointStoredPaths: effects.stored,
  getPrefs: () => ({ recentWorkspaces: [{ path: '/old' }, { path: '/other' }] }),
  setRecentWorkspaces: effects.recent,
}))
import { deleteSandbox, renameSandbox, sandboxBase } from './sandbox-service'

beforeEach(() => {
  vi.resetAllMocks()
  effects.order.length = 0
  effects.live.mockReturnValue([])
  effects.plan.mockReturnValue({ ok: true, from: '/old', to: '/new' })
  effects.resolve.mockReturnValue('/old')
  effects.rename.mockImplementation(async () => {
    effects.order.push('rename')
  })
  effects.move.mockImplementation(async () => {
    effects.order.push('move')
  })
  effects.repair.mockImplementation(async () => {
    effects.order.push('repair')
  })
  effects.stored.mockImplementation(() => {
    effects.order.push('prefs')
  })
})

it('resolves the sandbox base lazily with a lexical fallback', () => {
  expect(effects.real).not.toHaveBeenCalled()
  expect(sandboxBase()).toBe('/data/sandboxes')
  effects.real.mockReturnValue('/resolved')
  expect(sandboxBase()).toBe('/resolved')
})

it('orders both cwd mappings around rename, then moves, repairs and preferences', async () => {
  expect(await renameSandbox('/old', 'new')).toEqual({ ok: true, path: '/new' })
  expect(effects.order).toEqual([
    'pi:/old',
    'pi:/old/lane',
    'rename',
    'pi:/new',
    'pi:/new/lane',
    'move',
    'move',
    'move',
    'move',
    'pi:/new',
    'repair',
    'pi:/new/lane',
    'repair',
    'prefs',
  ])
  expect(effects.move).toHaveBeenCalledWith('/cli/old/lane', '/cli/new/lane')
  expect(effects.repair).toHaveBeenCalledWith('/pi/new/lane', '/old/lane', '/new/lane')
})

it('refuses a live descendant and accepts no-op rename before liveness checks', async () => {
  effects.live.mockReturnValue([{ workspacePath: '/old/lane' }])
  expect(await renameSandbox('/old', 'new')).toEqual({ ok: false, reason: 'in-use' })
  expect(await deleteSandbox('/old')).toEqual({ ok: false, reason: 'in-use' })
  expect(effects.rename).not.toHaveBeenCalled()
  expect(effects.trash).not.toHaveBeenCalled()
  effects.plan.mockReturnValue({ ok: true, from: '/old', to: '/old' })
  expect(await renameSandbox('/old', 'old')).toEqual({ ok: true, path: '/old' })
})

it('maps all transcripts before Trash and prunes recents after best-effort disposal', async () => {
  effects.trash.mockImplementation(async () => {
    effects.order.push('trash')
  })
  effects.trashTranscript.mockImplementation(async () => {
    effects.order.push('transcript')
    throw new Error('locked')
  })
  effects.recent.mockImplementation(() => {
    effects.order.push('prefs')
  })
  expect(await deleteSandbox('/old')).toEqual({ ok: true })
  expect(effects.order).toEqual([
    'pi:/old',
    'pi:/old/lane',
    'trash',
    'transcript',
    'transcript',
    'transcript',
    'transcript',
    'prefs',
  ])
  expect(effects.recent).toHaveBeenCalledWith([{ path: '/other' }])
})
