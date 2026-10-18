import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'typescript' }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: vi.fn() }))
import { entryPath, trashEntry } from './fileActions'
import { useFilesStore } from '@/stores/files'
import { releaseFileModel } from '@/features/files/MonacoEditor'

afterEach(async () => {
  // reconcilePath lazily releases Monaco models; finish before removing mocks.
  await vi.dynamicImportSettled()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('only closes trashed tabs after confirmation and successful IPC', async () => {
  const entry = { name: 'docs', path: '/repo/docs', relativePath: 'docs', isDirectory: true }
  const confirm = vi.fn(() => false)
  const invoke = vi.fn().mockRejectedValue(new Error('Permission denied'))
  vi.stubGlobal('window', { confirm, phosphor: { invoke } })
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

it('retargets dirty descendants without losing buffers, and closes them after trash', async () => {
  const file = (path: string) => ({
    path,
    relativePath: path.slice(6),
    language: 'typescript',
    savedContent: 'disk',
    content: 'unsaved',
    mtimeMs: 1,
    size: 0,
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
  await vi.dynamicImportSettled()
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
  await vi.dynamicImportSettled()
  expect(releaseFileModel).toHaveBeenCalledWith('/repo/src/a.ts')
  expect(releaseFileModel).toHaveBeenCalledWith('/repo/lib/a.ts')
})

it('characterizes trash warning and success-only tab reconciliation', async () => {
  const { usePromptStore } = await import('@/stores/prompt')
  const messages: string[] = []
  const unsubscribe = usePromptStore.subscribe((state) => {
    for (const request of state.requests) {
      messages.push(`${request.title} ${request.message ?? ''}`)
      usePromptStore.getState().dismiss(request, 'trash')
    }
  })
  const invoke = vi.fn().mockRejectedValue(new Error('Trash unavailable'))
  vi.stubGlobal('window', {
    confirm: (message: string) => {
      messages.push(message)
      return true
    },
    phosphor: { invoke },
  })
  useFilesStore.setState({
    byWorkspace: {
      '/repo': {
        openFiles: [
          {
            path: '/repo/docs/draft.md',
            relativePath: 'docs/draft.md',
            language: 'markdown',
            content: 'draft',
            savedContent: '',
            dirty: true,
            mtimeMs: 1,
            size: 0,
          },
        ],
        activePath: '/repo/docs/draft.md',
        gitStatus: {},
      },
    },
  })
  const reconcile = vi.spyOn(useFilesStore.getState(), 'reconcilePath').mockImplementation(() => {})
  const refresh = vi.spyOn(useFilesStore.getState(), 'refreshDir').mockResolvedValue()
  const entry = { name: 'docs', path: '/repo/docs', relativePath: 'docs', isDirectory: true }
  try {
    await expect(trashEntry('/repo', entry)).rejects.toThrow('Trash unavailable')
    expect(reconcile).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    invoke.mockResolvedValue(undefined)
    await trashEntry('/repo', entry)
    expect(messages).toHaveLength(2)
    expect(messages.every((message) => message.includes('Unsaved edits will be lost.'))).toBe(true)
    expect(invoke).toHaveBeenLastCalledWith('fs:trash', '/repo/docs')
    expect(reconcile).toHaveBeenCalledExactlyOnceWith('/repo', '/repo/docs')
    expect(refresh).toHaveBeenCalledExactlyOnceWith('/repo', '/repo')
  } finally {
    unsubscribe()
  }
})
