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
  const { usePromptStore } = await import('@/stores/prompt')
  const invoke = vi.fn().mockRejectedValue(new Error('Permission denied'))
  vi.stubGlobal('window', { phosphor: { invoke } })
  const reconcile = vi.spyOn(useFilesStore.getState(), 'reconcilePath').mockImplementation(() => {})
  vi.spyOn(useFilesStore.getState(), 'refreshDir').mockResolvedValue()
  const cancelled = trashEntry('/repo', entry)
  usePromptStore.getState().dismiss(usePromptStore.getState().requests[0]!, undefined)
  await cancelled
  expect(invoke).not.toHaveBeenCalled()
  const failed = trashEntry('/repo', entry)
  usePromptStore.getState().dismiss(usePromptStore.getState().requests[0]!, 'trash')
  await expect(failed).rejects.toThrow('Permission denied')
  expect(reconcile).not.toHaveBeenCalled()
  invoke.mockResolvedValue(undefined)
  const successful = trashEntry('/repo', entry)
  usePromptStore.getState().dismiss(usePromptStore.getState().requests[0]!, 'trash')
  await successful
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

it('queues trash, cancels without IPC, and ignores non-affirmative values', async () => {
  const { usePromptStore } = await import('@/stores/prompt')
  const invoke = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { confirm: vi.fn(() => true), phosphor: { invoke } })
  useFilesStore.setState({ byWorkspace: {} })
  const entry = { name: 'docs', path: '/repo/docs', relativePath: 'docs', isDirectory: true }
  for (const choice of [undefined, 'not-trash']) {
    const pending = trashEntry('/repo', entry)
    try {
      expect(invoke).not.toHaveBeenCalled()
      expect(usePromptStore.getState().requests).toHaveLength(1)
      const request = usePromptStore.getState().requests[0]!
      expect(request.kind).toBe('choice')
      expect(request.choices).toContainEqual(expect.objectContaining({ value: 'trash' }))
      usePromptStore.getState().dismiss(request, choice)
      await pending
      expect(invoke).not.toHaveBeenCalled()
    } finally {
      for (const request of usePromptStore.getState().requests)
        usePromptStore.getState().dismiss(request, undefined)
      await pending
    }
  }
})

it('confirms trash once across repeated clicks during choice and IPC', async () => {
  const { usePromptStore } = await import('@/stores/prompt')
  const finishes: (() => void)[] = []
  const invoke = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishes.push(resolve)
      }),
  )
  vi.stubGlobal('window', { confirm: vi.fn(() => true), phosphor: { invoke } })
  useFilesStore.setState({ byWorkspace: {} })
  const reconcile = vi.spyOn(useFilesStore.getState(), 'reconcilePath').mockImplementation(() => {})
  const refresh = vi.spyOn(useFilesStore.getState(), 'refreshDir').mockResolvedValue()
  const entry = { name: 'docs', path: '/repo/docs', relativePath: 'docs', isDirectory: true }
  const pending = trashEntry('/repo', entry)
  const repeated = trashEntry('/repo', entry)
  try {
    expect(invoke).not.toHaveBeenCalled()
    expect(usePromptStore.getState().requests).toHaveLength(1)
    usePromptStore.getState().dismiss(usePromptStore.getState().requests[0]!, 'trash')
    await Promise.resolve()
    await trashEntry('/repo', entry)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('fs:trash', entry.path)
    expect(reconcile).not.toHaveBeenCalled()
    finishes.forEach((finish) => finish())
    await pending
    expect(reconcile).toHaveBeenCalledExactlyOnceWith('/repo', entry.path)
    expect(refresh).toHaveBeenCalledExactlyOnceWith('/repo', '/repo')
  } finally {
    for (const request of usePromptStore.getState().requests)
      usePromptStore.getState().dismiss(request, undefined)
    finishes.forEach((finish) => finish())
    await Promise.all([pending, repeated])
  }
})

it('asks again with the unsaved warning when a descendant becomes dirty while queued', async () => {
  const { usePromptStore } = await import('@/stores/prompt')
  const invoke = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { confirm: vi.fn(() => true), phosphor: { invoke } })
  useFilesStore.setState({ byWorkspace: {} })
  const entry = { name: 'docs', path: '/repo/docs', relativePath: 'docs', isDirectory: true }
  const pending = trashEntry('/repo', entry)
  try {
    expect(invoke).not.toHaveBeenCalled()
    const request = usePromptStore.getState().requests[0]!
    expect(`${request.title} ${request.message ?? ''}`).not.toContain('Unsaved edits')
    useFilesStore.setState({
      byWorkspace: {
        '/repo': {
          openFiles: [
            {
              path: '/repo/docs/new.md',
              relativePath: 'docs/new.md',
              language: 'markdown',
              content: 'draft',
              savedContent: '',
              dirty: true,
              mtimeMs: 1,
              size: 0,
            },
          ],
          activePath: '/repo/docs/new.md',
          gitStatus: {},
        },
      },
    })
    usePromptStore.getState().dismiss(request, 'trash')
    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
    expect(usePromptStore.getState().requests).toHaveLength(1)
    const warning = usePromptStore.getState().requests[0]!
    expect(`${warning.title} ${warning.message ?? ''}`).toContain('Unsaved edits will be lost.')
    usePromptStore.getState().dismiss(warning, undefined)
    await pending
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    for (const request of usePromptStore.getState().requests)
      usePromptStore.getState().dismiss(request, undefined)
    await pending
  }
})

it('uses at most two choices when newly dirty trash is affirmed', async () => {
  const { usePromptStore } = await import('@/stores/prompt')
  const invoke = vi.fn().mockResolvedValue({ content: 'disk', size: 4, mtimeMs: 1 })
  vi.stubGlobal('window', { phosphor: { invoke } })
  useFilesStore.setState({ byWorkspace: {} })
  await useFilesStore.getState().openFile('/repo', '/repo/docs/draft.md')
  const reconcile = vi.spyOn(useFilesStore.getState(), 'reconcilePath').mockImplementation(() => {})
  vi.spyOn(useFilesStore.getState(), 'refreshDir').mockResolvedValue()
  invoke.mockClear()
  const entry = { name: 'docs', path: '/repo/docs', relativePath: 'docs', isDirectory: true }
  const pending = trashEntry('/repo', entry)
  useFilesStore.getState().updateBuffer('/repo', '/repo/docs/draft.md', 'draft')
  usePromptStore.getState().dismiss(usePromptStore.getState().requests[0]!, 'trash')
  await Promise.resolve()
  expect(invoke).not.toHaveBeenCalled()
  const warning = usePromptStore.getState().requests[0]!
  expect(warning.message).toBe('Unsaved edits will be lost.')
  usePromptStore.getState().dismiss(warning, 'trash')
  await pending
  expect(usePromptStore.getState().requests).toEqual([])
  expect(invoke).toHaveBeenCalledExactlyOnceWith('fs:trash', entry.path)
  expect(reconcile).toHaveBeenCalledExactlyOnceWith('/repo', entry.path)
})
