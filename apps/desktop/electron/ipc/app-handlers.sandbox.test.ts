import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  access: vi.fn(),
  rename: vi.fn(),
  readdir: vi.fn(),
  trash: vi.fn(),
  repoint: vi.fn(),
  stored: vi.fn(),
  recent: vi.fn(),
  live: vi.fn(),
  plan: vi.fn(),
  resolve: vi.fn(),
  sessionDir: vi.fn(),
  claudeDir: vi.fn(),
  open: vi.fn(),
  list: vi.fn(),
}))
vi.mock('./handle', () => ({
  handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
    mocks.handlers.set(channel, handler),
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/data' },
  BrowserWindow: {},
  dialog: {},
  shell: { trashItem: mocks.trash },
}))
vi.mock('node:fs/promises', () => ({
  access: mocks.access,
  rename: mocks.rename,
  readdir: mocks.readdir,
}))
vi.mock('../sandbox', () => ({
  planSandboxRename: mocks.plan,
  resolveSandboxFolder: mocks.resolve,
  sandboxCwds: (path: string) => [path, `${path}/.phosphor/worktrees/lane`],
  openSandboxFolder: mocks.open,
  listSandboxFolders: mocks.list,
}))
vi.mock('../pi/pi-paths', () => ({
  sessionDirForCwd: mocks.sessionDir,
  claudeProjectDirForCwd: mocks.claudeDir,
}))
vi.mock('../pi/session-cwd', () => ({ repointSessionCwd: mocks.repoint }))
vi.mock('../registry', () => ({ registry: { list: mocks.live } }))
vi.mock('../pi/context-budget', () => ({}))
vi.mock('../pi/context-files', () => ({}))
vi.mock('../pi/stub', () => ({}))
vi.mock('../routines/ownership', () => ({}))
vi.mock('../window-chrome', () => ({}))
vi.mock('../debug-log', () => ({}))
vi.mock('../store', () => ({
  realPathOrNull: () => '/real/sandboxes',
  repointStoredPaths: mocks.stored,
  getPrefs: () => ({ recentWorkspaces: [{ path: from }, { path: '/other' }] }),
  setRecentWorkspaces: mocks.recent,
}))

import { registerAppHandlers } from './app-handlers'

const from = '/real/sandboxes/old'
const to = '/real/sandboxes/new'
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args)

beforeEach(() => {
  vi.resetAllMocks()
  mocks.handlers.clear()
  mocks.plan.mockReturnValue({ ok: true, from, to })
  mocks.resolve.mockReturnValue(from)
  mocks.live.mockReturnValue([])
  mocks.access.mockImplementation(async (path: string) => {
    if (path.startsWith('/pi' + to) || path.startsWith('/cli' + to)) throw new Error('missing')
  })
  mocks.readdir.mockResolvedValue(['one.jsonl', 'notes.txt', 'two.jsonl'])
  mocks.sessionDir.mockImplementation((cwd: string) => '/pi' + cwd)
  mocks.claudeDir.mockImplementation((cwd: string) => '/cli' + cwd)
  registerAppHandlers()
})

it('forwards sandbox base, channel args, policy errors and creation errors', async () => {
  mocks.open.mockReturnValue(from)
  mocks.list.mockReturnValue([{ path: from }])
  expect(invoke('app:createSandbox')).toBe(from)
  expect(mocks.open).toHaveBeenCalledWith('/real/sandboxes')
  expect(invoke('app:listSandboxes')).toEqual([{ path: from }])
  expect(mocks.list).toHaveBeenCalledWith('/real/sandboxes')
  mocks.plan.mockReturnValue({ ok: false, reason: 'invalid-name' })
  await expect(invoke('app:renameSandbox', from, ':')).resolves.toEqual({
    ok: false,
    reason: 'invalid-name',
  })
  expect(mocks.plan).toHaveBeenCalledWith('/real/sandboxes', from, ':')
  mocks.resolve.mockReturnValue(null)
  await expect(invoke('app:deleteSandbox', '/outside')).resolves.toEqual({
    ok: false,
    reason: 'not-a-sandbox',
  })
  expect(mocks.resolve).toHaveBeenCalledWith('/real/sandboxes', '/outside')
  mocks.open.mockImplementation(() => {
    throw new Error('create failed')
  })
  expect(() => invoke('app:createSandbox')).toThrow('create failed')
})

it('refuses live descendants for rename and delete before side effects', async () => {
  mocks.live.mockReturnValue([{ workspacePath: `${from}/.phosphor/worktrees/lane` }])
  for (const channel of ['app:renameSandbox', 'app:deleteSandbox']) {
    await expect(invoke(channel, from, 'new')).resolves.toEqual({ ok: false, reason: 'in-use' })
  }
  expect(mocks.rename).not.toHaveBeenCalled()
  expect(mocks.trash).not.toHaveBeenCalled()
})

it('accepts a no-op rename even while live without touching disk', async () => {
  mocks.plan.mockReturnValue({ ok: true, from, to: from })
  mocks.live.mockReturnValue([{ workspacePath: from }])
  await expect(invoke('app:renameSandbox', from, 'old')).resolves.toEqual({ ok: true, path: from })
  expect(mocks.live).not.toHaveBeenCalled()
  expect(mocks.rename).not.toHaveBeenCalled()
})

it('maps paths before and after rename, repairs JSONL headers and repoints preferences', async () => {
  await expect(invoke('app:renameSandbox', from, 'new')).resolves.toEqual({ ok: true, path: to })
  const folderMove = mocks.rename.mock.invocationCallOrder[0]!
  expect(mocks.sessionDir.mock.invocationCallOrder[1]).toBeLessThan(folderMove)
  expect(mocks.sessionDir.mock.invocationCallOrder[2]).toBeGreaterThan(folderMove)
  expect(mocks.rename).toHaveBeenCalledWith(from, to)
  expect(mocks.rename).toHaveBeenCalledWith('/pi' + from, '/pi' + to)
  expect(mocks.rename).toHaveBeenCalledWith('/cli' + from, '/cli' + to)
  expect(mocks.repoint).toHaveBeenCalledWith('/pi' + to + '/one.jsonl', from, to)
  expect(mocks.repoint).toHaveBeenCalledWith(
    '/pi' + to + '/.phosphor/worktrees/lane/two.jsonl',
    from + '/.phosphor/worktrees/lane',
    to + '/.phosphor/worktrees/lane',
  )
  expect(mocks.repoint).toHaveBeenCalledTimes(4)
  expect(mocks.stored).toHaveBeenCalledWith([
    { from, to },
    { from: '/pi' + from, to: '/pi' + to },
    { from: '/cli' + from, to: '/cli' + to },
    {
      from: '/pi' + from + '/.phosphor/worktrees/lane',
      to: '/pi' + to + '/.phosphor/worktrees/lane',
    },
    {
      from: '/cli' + from + '/.phosphor/worktrees/lane',
      to: '/cli' + to + '/.phosphor/worktrees/lane',
    },
  ])
})

it('leaves occupied transcript targets alone and tolerates individual repair failures', async () => {
  mocks.access.mockResolvedValue(undefined)
  mocks.repoint.mockRejectedValueOnce(new Error('unreadable'))
  await expect(invoke('app:renameSandbox', from, 'new')).resolves.toEqual({ ok: true, path: to })
  expect(mocks.rename).toHaveBeenCalledTimes(1)
  expect(mocks.repoint).toHaveBeenCalledTimes(4)
  expect(mocks.stored).toHaveBeenCalledTimes(1)
})

it('keeps a successful folder rename despite failed transcript moves and directory reads', async () => {
  mocks.rename.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('move failed'))
  mocks.readdir.mockRejectedValue(new Error('missing'))
  await expect(invoke('app:renameSandbox', from, 'new')).resolves.toEqual({ ok: true, path: to })
  expect(mocks.rename).toHaveBeenCalledTimes(5)
  expect(mocks.stored).toHaveBeenCalledTimes(1)
})

it('returns folder mutation failures without moving transcripts or changing preferences', async () => {
  mocks.rename.mockRejectedValue(new Error('denied'))
  mocks.trash.mockRejectedValue(new Error('denied'))
  await expect(invoke('app:renameSandbox', from, 'new')).resolves.toEqual({
    ok: false,
    reason: 'failed',
  })
  await expect(invoke('app:deleteSandbox', from)).resolves.toEqual({ ok: false, reason: 'failed' })
  expect(mocks.rename).toHaveBeenCalledTimes(1)
  expect(mocks.trash).toHaveBeenCalledTimes(1)
  expect(mocks.stored).not.toHaveBeenCalled()
  expect(mocks.recent).not.toHaveBeenCalled()
})

it('trashes folder before subtree transcripts and prunes recents despite partial trash failure', async () => {
  mocks.trash.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('locked'))
  await expect(invoke('app:deleteSandbox', from)).resolves.toEqual({ ok: true })
  expect(mocks.trash.mock.calls.map(([path]) => path)).toEqual([
    from,
    '/pi' + from,
    '/cli' + from,
    '/pi' + from + '/.phosphor/worktrees/lane',
    '/cli' + from + '/.phosphor/worktrees/lane',
  ])
  expect(mocks.sessionDir.mock.invocationCallOrder[1]).toBeLessThan(
    mocks.trash.mock.invocationCallOrder[0]!,
  )
  expect(mocks.recent).toHaveBeenCalledWith([{ path: '/other' }])
})
