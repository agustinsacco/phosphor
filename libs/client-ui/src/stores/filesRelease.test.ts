import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The files store retains the heaviest renderer state: every open file holds
 * `content` AND `savedContent`, plus a Monaco model (which Monaco keeps in a
 * global registry, mirrored into a language web worker) — so browsing files
 * across projects retained everything until quit.
 *
 * Monaco is stubbed: these assertions are about the STORE releasing its slices
 * and calling the release hook, not about the editor bundle.
 */
const releaseFileModel = vi.fn()
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel }))
// `languageForPath` is imported eagerly by the store; the real module pulls in
// monaco-editor's worker entry points, which vitest cannot resolve.
vi.mock('@/lib/monaco', () => ({
  languageForPath: () => 'typescript',
  peekMonaco: () => null,
}))

const openFile = (path: string): Record<string, unknown> => ({
  path,
  relativePath: path.split('/').pop(),
  language: 'typescript',
  savedContent: 'x'.repeat(1000),
  content: 'x'.repeat(1000),
  mtimeMs: 1,
  dirty: false,
})

describe('files store release', () => {
  beforeEach(() => {
    releaseFileModel.mockClear()
  })

  it('releases the Monaco model when a file is closed', async () => {
    const { useFilesStore } = await import('./files')
    useFilesStore.setState({
      byWorkspace: {
        '/repo': {
          openFiles: [openFile('/repo/a.ts'), openFile('/repo/b.ts')],
          activePath: '/repo/a.ts',
          gitStatus: {},
        },
      },
    } as never)

    useFilesStore.getState().closeFile('/repo', '/repo/a.ts')

    const slice = useFilesStore.getState().byWorkspace['/repo']!
    expect(slice.openFiles.map((f) => f.path)).toEqual(['/repo/b.ts'])
    expect(slice.activePath).toBe('/repo/b.ts')

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(releaseFileModel).toHaveBeenCalledWith('/repo/a.ts')
  })

  it('drops the whole workspace slice and releases each open model', async () => {
    const { useFilesStore } = await import('./files')
    useFilesStore.setState({
      byWorkspace: {
        '/repo': {
          openFiles: [openFile('/repo/a.ts'), openFile('/repo/b.ts')],
          activePath: null,
          gitStatus: {},
        },
        '/other': { openFiles: [openFile('/other/c.ts')], activePath: null, gitStatus: {} },
      },
      entries: { '/repo': [], '/repo/src': [], '/other': [] },
      expanded: { '/repo/src': true, '/other': true },
    } as never)

    useFilesStore.getState().releaseWorkspace('/repo')
    const state = useFilesStore.getState()

    expect(state.byWorkspace).not.toHaveProperty('/repo')
    // Explorer listings are keyed by absolute dir path, so they prune by prefix.
    expect(Object.keys(state.entries)).toEqual(['/other'])
    expect(Object.keys(state.expanded)).toEqual(['/other'])

    // The untouched workspace keeps everything.
    expect(state.byWorkspace).toHaveProperty('/other')

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(releaseFileModel).toHaveBeenCalledWith('/repo/a.ts')
    expect(releaseFileModel).toHaveBeenCalledWith('/repo/b.ts')
    expect(releaseFileModel).not.toHaveBeenCalledWith('/other/c.ts')
  })

  it('does not prune a sibling workspace whose path shares a prefix', async () => {
    // `/repo` must not take `/repo-two` with it.
    const { useFilesStore } = await import('./files')
    useFilesStore.setState({
      byWorkspace: { '/repo': { openFiles: [], activePath: null, gitStatus: {} } },
      entries: { '/repo': [], '/repo-two': [], '/repo-two/src': [] },
      expanded: { '/repo-two/src': true },
    } as never)

    useFilesStore.getState().releaseWorkspace('/repo')
    const state = useFilesStore.getState()

    expect(Object.keys(state.entries).sort()).toEqual(['/repo-two', '/repo-two/src'])
    expect(state.expanded).toHaveProperty('/repo-two/src')
  })

  it('is a no-op for a workspace that was never opened', async () => {
    const { useFilesStore } = await import('./files')
    useFilesStore.setState({
      byWorkspace: { '/keep': { openFiles: [], activePath: null, gitStatus: {} } },
      entries: { '/keep': [] },
      expanded: {},
    } as never)

    useFilesStore.getState().releaseWorkspace('/never-opened')
    expect(useFilesStore.getState().byWorkspace).toHaveProperty('/keep')
    expect(releaseFileModel).not.toHaveBeenCalled()
  })
})
