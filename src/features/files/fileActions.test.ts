import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'typescript' }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: vi.fn() }))
import { entryPath, trashEntry } from './fileActions'
import { useFilesStore } from '@/stores/files'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('only closes trashed tabs after confirmation and successful IPC', async () => {
  const entry = { name: 'docs', path: '/repo/docs', relativePath: 'docs', isDirectory: true }
  const confirm = vi.fn(() => false)
  const invoke = vi.fn().mockRejectedValue(new Error('Permission denied'))
  vi.stubGlobal('window', { confirm, pidex: { invoke } })
  const reconcile = vi.spyOn(useFilesStore.getState(), 'reconcilePath').mockImplementation(() => {})
  vi.spyOn(useFilesStore.getState(), 'refreshDir').mockResolvedValue()
  await trashEntry('/repo', entry)
  expect(invoke).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  await expect(trashEntry('/repo', entry)).rejects.toThrow('Permission denied')
  expect(reconcile).not.toHaveBeenCalled()
  invoke.mockResolvedValue(undefined)
  await trashEntry('/repo', entry)
  expect(invoke).toHaveBeenCalledWith('fs:trash', entry.path)
  expect(reconcile).toHaveBeenCalledWith('/repo', entry.path)
})

it('accepts file names, not traversal or absolute paths', () => {
  for (const name of ['..', '.', '../out', '/tmp/out', 'a\\b', '\0', ' ']) {
    expect(() => entryPath('/repo', name)).toThrow()
  }
  expect(entryPath('/repo/', 'notes.md')).toBe('/repo/notes.md')
  expect(entryPath('C:\\repo', 'notes.md')).toBe('C:\\repo\\notes.md')
})

it('retargets dirty descendants without losing buffers, and closes them after trash', () => {
  const file = (path: string) => ({
    path,
    relativePath: path.slice(6),
    language: 'typescript',
    savedContent: 'disk',
    content: 'unsaved',
    mtimeMs: 1,
    dirty: true,
  })
  useFilesStore.setState({
    byWorkspace: {
      '/repo': {
        openFiles: [file('/repo/src/a.ts'), file('/repo/src-other.ts')],
        activePath: '/repo/src/a.ts',
        gitStatus: {},
      },
      '/other': { openFiles: [file('/other/a.ts')], activePath: '/other/a.ts', gitStatus: {} },
    },
    entries: { '/repo': [], '/repo/src': [], '/repo/src/nested': [] },
    expanded: { '/repo/src': true },
  })
  const store = useFilesStore.getState()
  store.reconcilePath('/repo', '/repo/src', '/repo/lib')
  const slice = useFilesStore.getState().byWorkspace['/repo']!
  expect(slice.activePath).toBe('/repo/lib/a.ts')
  expect(slice.openFiles[0]).toMatchObject({
    path: '/repo/lib/a.ts',
    content: 'unsaved',
    dirty: true,
  })
  expect(useFilesStore.getState().entries).toEqual({ '/repo': [] })
  store.reconcilePath('/repo', '/repo/lib')
  expect(useFilesStore.getState().byWorkspace['/repo']!.openFiles.map((f) => f.path)).toEqual([
    '/repo/src-other.ts',
  ])
  expect(useFilesStore.getState().byWorkspace['/other']!.activePath).toBe('/other/a.ts')
})
