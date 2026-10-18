import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFS, type ComposerDraftRecord } from '@shared/models'

const m = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  store: Object.fromEntries(
    [
      'getPrefs',
      'markSessionSeen',
      'recordWorkspace',
      'setCollapsedWorkspaces',
      'setFontPrefs',
      'setLastSession',
      'setModelPicks',
      'setLaneMarkers',
      'setLanePrefs',
      'setPinnedSessions',
      'setRewoundSessions',
      'setSessionOrder',
      'setRecentWorkspaces',
      'setTheme',
      'setAgentDirectives',
      'setWorktreePrefs',
      'setContextBudget',
      'setContextFile',
      'setDraft',
      'clearDraft',
      'setDrafts',
      'realPathOrNull',
    ].map((key) => [key, vi.fn()]),
  ),
  packaged: false,
  open: vi.fn(),
  save: vi.fn(),
  reveal: vi.fn(),
  external: vi.fn(),
  window: vi.fn(),
  theme: vi.fn(),
  overlay: vi.fn(),
  zoom: vi.fn(),
  access: vi.fn(),
  remove: vi.fn(),
  listBlobs: vi.fn(),
  read: vi.fn(),
  cap: vi.fn(),
  write: vi.fn(),
  stub: vi.fn(),
  live: vi.fn(),
  session: vi.fn(),
  serialize: vi.fn(),
  sync: vi.fn(),
  context: vi.fn(),
  routine: vi.fn(),
}))
vi.mock('./handle', () => ({
  handle: (key: string, fn: (...args: unknown[]) => unknown) => m.handlers.set(key, fn),
}))
vi.mock('../store', () => m.store)
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return m.packaged
    },
    getVersion: () => '1.2.3',
  },
  BrowserWindow: { fromWebContents: m.window },
  dialog: { showOpenDialog: m.open, showSaveDialog: m.save },
  shell: { showItemInFolder: m.reveal, openExternal: m.external },
}))
vi.mock('node:fs/promises', () => ({ access: m.access }))
vi.mock('../sandbox', () => ({}))
vi.mock('../sandbox-service', () => ({}))
vi.mock('../registry', () => ({ registry: { list: m.live, get: m.session } }))
vi.mock('../pi/context-budget', () => ({
  syncContextBudget: m.sync,
  withBudgetCompaction: m.serialize,
}))
vi.mock('../pi/context-files', () => ({ setLaneContextFile: m.context }))
vi.mock('../pi/stub', () => ({ piStubPath: m.stub }))
vi.mock('../routines/ownership', () => ({ isRoutineSession: m.routine }))
vi.mock('../window-chrome', () => ({
  applyThemeSource: m.theme,
  applyTitleBarOverlay: m.overlay,
  applyZoom: m.zoom,
}))
vi.mock('../drafts-blobs', () => ({
  deleteDraftBlobs: m.remove,
  listDraftBlobs: m.listBlobs,
  readDraftBlob: m.read,
  wouldExceedBlobCap: m.cap,
  writeDraftBlob: m.write,
}))
vi.mock('../debug-log', () => ({}))
vi.mock('node:os', () => ({ userInfo: () => ({ username: 'tester' }) }))
import { registerAppHandlers } from './app-handlers'

const event = { sender: { id: 7 } }
const invoke = (channel: string, ...args: unknown[]) =>
  m.handlers.get('app:' + channel)!(event, ...args)
const draft = (key: string, blobId: string): ComposerDraftRecord => ({
  key,
  text: 'unsent',
  attachments: [{ kind: 'image', blobId, mimeType: 'image/png', name: 'image', size: 3 }],
  updatedAt: Date.now(),
})
beforeEach(() => {
  vi.resetAllMocks()
  m.handlers.clear()
  m.packaged = false
  m.store.getPrefs!.mockReturnValue({ ...DEFAULT_APP_PREFS })
  m.live.mockReturnValue([])
  m.listBlobs.mockResolvedValue([])
  registerAppHandlers()
})
afterEach(() => vi.unstubAllEnvs())

const forwards: [string, unknown[]][] = [
  ['setSessionOrder', [['session']]],
  ['setPinnedSessions', [['pin']]],
  ['setRewoundSessions', [{ session: true }]],
  ['setLanePrefs', [{ base: 'main' }]],
  ['setLaneMarkers', [{ session: 'red' }]],
  ['setModelPicks', [{ model: 'test' }]],
  ['setLastSession', ['session']],
  ['setCollapsedWorkspaces', [['workspace']]],
  ['setRecentWorkspaces', [[{ path: '/ws' }]]],
  ['setWorktreePrefs', [{ root: '/trees' }]],
  ['setAgentDirectives', [{ enabled: false }, '/ws']],
  ['markSessionSeen', ['session']],
]
it.each(forwards)(
  '%s forwards arguments, returns void and preserves store errors',
  (channel, args) => {
    expect(invoke(channel, ...args)).toBeUndefined()
    expect(m.store[channel]).toHaveBeenCalledWith(...args)
    m.store[channel]!.mockImplementation(() => {
      throw new Error('persist failed')
    })
    expect(() => invoke(channel, ...args)).toThrow('persist failed')
  },
)

it('returns preferences and records the workspace basename', () => {
  expect(invoke('getPrefs')).toEqual(DEFAULT_APP_PREFS)
  invoke('recordWorkspace', '/parent/project')
  expect(m.store.recordWorkspace).toHaveBeenCalledWith('/parent/project', 'project')
  m.store.getPrefs!.mockImplementation(() => {
    throw new Error('read failed')
  })
  expect(() => invoke('getPrefs')).toThrow('read failed')
})

it('persists theme and fonts before OS updates and does not update after persistence failure', () => {
  invoke('setTheme', 'dark')
  expect(m.store.setTheme).toHaveBeenCalledWith('dark')
  expect(m.overlay).toHaveBeenCalledWith('dark')
  expect(m.theme).toHaveBeenCalledWith('dark')
  expect(m.store.setTheme!.mock.invocationCallOrder[0]).toBeLessThan(
    m.overlay.mock.invocationCallOrder[0]!,
  )
  expect(m.overlay.mock.invocationCallOrder[0]).toBeLessThan(m.theme.mock.invocationCallOrder[0]!)
  invoke('setFontPrefs', { uiScale: 1.2 })
  expect(m.store.setFontPrefs).toHaveBeenCalledWith({ uiScale: 1.2 })
  expect(m.zoom).toHaveBeenCalledWith(1.2)
  expect(m.store.setFontPrefs!.mock.invocationCallOrder[0]).toBeLessThan(
    m.zoom.mock.invocationCallOrder[0]!,
  )
  m.store.setTheme!.mockImplementation(() => {
    throw new Error('persist')
  })
  expect(() => invoke('setTheme', 'light')).toThrow('persist')
  expect(m.theme).toHaveBeenCalledTimes(1)
})

it('serializes context sync per session and reads the latest saved budget inside admission', async () => {
  const admitted: (() => Promise<void>)[] = []
  m.live.mockReturnValue([{ sessionId: 'a' }, { sessionId: 'gone' }])
  m.serialize.mockImplementation((_id, _mode, fn: () => Promise<void>) => {
    admitted.push(fn)
  })
  await invoke('setContextBudget', '200k')
  expect(m.store.setContextBudget).toHaveBeenCalledWith('200k')
  expect(m.serialize.mock.calls.map(([id, mode]) => [id, mode])).toEqual([
    ['a', 'prompt'],
    ['gone', 'prompt'],
  ])
  expect(m.store.setContextBudget!.mock.invocationCallOrder[0]).toBeLessThan(
    m.serialize.mock.invocationCallOrder[0]!,
  )
  expect(m.sync).not.toHaveBeenCalled()
  m.store.getPrefs!.mockReturnValue({ ...DEFAULT_APP_PREFS, contextBudget: '300k' })
  m.session.mockImplementation((id: string) => (id === 'a' ? { client: 'client' } : undefined))
  await Promise.all(admitted.map((fn) => fn()))
  expect(m.sync).toHaveBeenCalledExactlyOnceWith('client', '300k')
  m.stub.mockReturnValue('/stub')
  await invoke('setContextBudget', '')
  expect(m.serialize).toHaveBeenCalledTimes(2)
})

it('forwards context file dependencies, arguments and failures', async () => {
  m.context.mockResolvedValue(undefined)
  await invoke('setContextFile', 'claude', false, 'session')
  const [deps, ...args] = m.context.mock.calls[0]!
  expect(args).toEqual(['claude', false, 'session'])
  expect(deps.save).toBe(m.store.setContextFile)
  expect(deps.ownedByRoutine).toBe(m.routine)
  deps.session('session')
  expect(m.session).toHaveBeenCalledWith('session')
  expect(deps.isStub()).toBe(false)
  m.context.mockRejectedValue(new Error('routine owned'))
  await expect(invoke('setContextFile', 'claude', true)).rejects.toThrow('routine owned')
})

it('prunes draft blobs, enforces decoded byte cap and forwards read/write failures', async () => {
  const value = draft('home:/ws', 'kept')
  m.store.setDraft!.mockReturnValue(['pruned'])
  m.store.clearDraft!.mockReturnValue(['cleared'])
  await invoke('setDraft', value)
  expect(m.store.setDraft).toHaveBeenCalledWith(value)
  expect(m.remove).toHaveBeenCalledWith(['pruned'])
  await invoke('clearDraft', value.key)
  expect(m.store.clearDraft).toHaveBeenCalledWith(value.key)
  expect(m.remove).toHaveBeenCalledWith(['cleared'])
  m.cap.mockResolvedValueOnce(true).mockResolvedValue(false)
  expect(await invoke('writeDraftBlob', 'image-id', 'YWJj')).toBe(false)
  expect(m.cap).toHaveBeenCalledWith(3)
  expect(m.write).not.toHaveBeenCalled()
  expect(await invoke('writeDraftBlob', 'image-id', 'YWJj')).toBe(true)
  expect(m.write).toHaveBeenCalledWith('image-id', 'YWJj')
  m.read.mockResolvedValue('YWJj')
  expect(await invoke('readDraftBlob', 'image-id')).toBe('YWJj')
  expect(m.read).toHaveBeenCalledWith('image-id')
  m.write.mockRejectedValue(new Error('disk'))
  await expect(invoke('writeDraftBlob', 'image-id', 'YWJj')).rejects.toThrow('disk')
  m.remove.mockRejectedValue(new Error('prune'))
  await expect(invoke('clearDraft', value.key)).rejects.toThrow('prune')
})

it('sweeps missing home drafts before listing and deleting dropped and orphan blobs', async () => {
  const kept = draft('home:/alive', 'kept')
  const gone = draft('home:/gone', 'dropped')
  const session = draft('session:/file', 'session-image')
  m.store.getPrefs!.mockReturnValue({
    drafts: { [kept.key]: kept, [gone.key]: gone, [session.key]: session },
  })
  m.access.mockImplementation(async (path: string) => {
    if (path === '/gone') throw new Error('gone')
  })
  m.listBlobs.mockResolvedValue(['kept', 'session-image', 'orphan'])
  const result = { [kept.key]: kept, [session.key]: session }
  expect(await invoke('sweepDrafts')).toEqual(result)
  expect(m.access.mock.calls).toEqual([['/alive'], ['/gone']])
  expect(m.store.setDrafts).toHaveBeenCalledWith(result)
  expect(m.remove).toHaveBeenCalledWith(['dropped', 'orphan'])
  expect(m.store.setDrafts!.mock.invocationCallOrder[0]).toBeLessThan(
    m.listBlobs.mock.invocationCallOrder[0]!,
  )
  expect(m.listBlobs.mock.invocationCallOrder[0]).toBeLessThan(
    m.remove.mock.invocationCallOrder[0]!,
  )
})

it('selects exact session, last workspace, newest existing recent, then none without sorting prefs', async () => {
  const prefs = {
    lastSessionPath: '/session',
    lastWorkspacePath: '/last',
    recentWorkspaces: [
      { path: '/old', lastOpenedAt: 1 },
      { path: '/new', lastOpenedAt: 3 },
      { path: '/middle', lastOpenedAt: 2 },
    ],
  }
  m.store.getPrefs!.mockReturnValue(prefs)
  expect(await invoke('resumeTarget')).toEqual({
    kind: 'session',
    sessionPath: '/session',
    workspacePath: '/last',
  })
  m.access.mockImplementation(async (p: string) => {
    if (p === '/session') throw new Error('gone')
  })
  expect(await invoke('resumeTarget')).toEqual({ kind: 'workspace', workspacePath: '/last' })
  m.access.mockImplementation(async (p: string) => {
    if (p !== '/middle' && p !== '/old') throw new Error('gone')
  })
  expect(await invoke('resumeTarget')).toEqual({ kind: 'workspace', workspacePath: '/middle' })
  expect(prefs.recentWorkspaces.map((ws) => ws.path)).toEqual(['/old', '/new', '/middle'])
  m.access.mockRejectedValue(new Error('gone'))
  expect(await invoke('resumeTarget')).toEqual({ kind: 'none' })
})

it('requires both saved paths to resume an existing session', async () => {
  m.store.getPrefs!.mockReturnValue({ lastSessionPath: '/session', recentWorkspaces: [] })
  expect(await invoke('resumeTarget')).toEqual({ kind: 'none' })
  m.store.getPrefs!.mockReturnValue({
    lastSessionPath: '/session',
    lastWorkspacePath: '/gone',
    recentWorkspaces: [],
  })
  m.access.mockImplementation(async (p: string) => {
    if (p === '/gone') throw new Error('gone')
  })
  expect(await invoke('resumeTarget')).toEqual({ kind: 'none' })
})

it('resolves selected symlinks, handles dismissal and gates the workspace override on unpackaged apps', async () => {
  m.open.mockResolvedValue({ canceled: false, filePaths: ['/link'] })
  m.store.realPathOrNull!.mockReturnValue('/real')
  expect(await invoke('selectFolder')).toBe('/real')
  expect(m.store.realPathOrNull).toHaveBeenCalledWith('/link')
  expect(m.window).toHaveBeenCalledWith(event.sender)
  expect(m.open.mock.calls[0]![1]).toEqual({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Open Workspace Folder',
  })
  vi.stubEnv('PHOSPHOR_E2E_WORKSPACE', '/override')
  expect(await invoke('selectFolder')).toBe('/real')
  expect(m.store.realPathOrNull).toHaveBeenLastCalledWith('/override')
  expect(m.open).toHaveBeenCalledTimes(1)
  m.packaged = true
  m.store.realPathOrNull!.mockReturnValue(null)
  expect(await invoke('selectFolder')).toBe('/link')
  m.open.mockResolvedValue({ canceled: true, filePaths: [] })
  expect(await invoke('selectFolder')).toBeNull()
  m.open.mockRejectedValue(new Error('dialog'))
  await expect(invoke('selectFolder')).rejects.toThrow('dialog')
})

it('forwards save options, native reveal and only allowed external URLs', async () => {
  const options = {
    title: 'Save',
    defaultPath: '/file',
    filters: [{ name: 'Text', extensions: ['txt'] }],
  }
  m.save.mockResolvedValue({ canceled: false, filePath: '/saved' })
  expect(await invoke('saveDialog', options)).toBe('/saved')
  expect(m.save.mock.calls[0]![1]).toEqual(options)
  m.save.mockResolvedValue({ canceled: false })
  expect(await invoke('saveDialog', options)).toBeNull()
  m.save.mockResolvedValue({ canceled: true, filePath: '/ignored' })
  expect(await invoke('saveDialog', options)).toBeNull()
  invoke('revealPath', '/file')
  expect(m.reveal).toHaveBeenCalledWith('/file')
  await invoke('openExternal', 'file:///private')
  expect(m.external).not.toHaveBeenCalled()
  await invoke('openExternal', 'https://example.com')
  expect(m.external).toHaveBeenCalledWith('https://example.com/')
  m.external.mockRejectedValue(new Error('browser'))
  await expect(invoke('openExternal', 'https://example.com')).rejects.toThrow('browser')
})

it('returns runtime metadata and only the AWS profile name', () => {
  vi.stubEnv('AWS_PROFILE', 'work')
  expect(invoke('userInfo')).toEqual({ username: 'tester', awsProfile: 'work' })
  expect(invoke('about')).toEqual({
    appVersion: '1.2.3',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  })
})
