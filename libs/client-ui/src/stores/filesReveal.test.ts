import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real module pulls in monaco-editor's worker entry points, which vitest cannot resolve.
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext', peekMonaco: () => null }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: () => {} }))

const invoke = vi.fn(async (_channel: string, path: string) => ({
  path,
  content: 'one\ntwo\n',
  size: 8,
  mtimeMs: 1,
}))

beforeEach(async () => {
  invoke.mockReset()
  invoke.mockImplementation(async (_channel: string, path: string) => ({
    path,
    content: 'one\ntwo\n',
    size: 8,
    mtimeMs: 1,
  }))
  vi.stubGlobal('window', { phosphor: { invoke } })
  const { useFilesStore } = await import('./files')
  useFilesStore.setState({ byWorkspace: {} })
})

async function openFiles() {
  const { useFilesStore, workspaceFiles } = await import('./files')
  const store = useFilesStore.getState()
  const file = (path: string) =>
    workspaceFiles(useFilesStore.getState(), '/repo').openFiles.find((f) => f.path === path)
  return { store, file }
}

describe('files store reveals', () => {
  it('makes a line target a reveal, and asking again for the same place a new request', async () => {
    const { store, file } = await openFiles()
    await store.openFile('/repo', '/repo/a.ts', 42)
    const first = file('/repo/a.ts')?.pendingReveal
    expect(first).toMatchObject({ line: 42 })
    await store.openFile('/repo', '/repo/a.ts', 42)
    const second = file('/repo/a.ts')?.pendingReveal
    expect(second?.line).toBe(42)
    expect(second!.seq).toBeGreaterThan(first!.seq)
    // Already open: no second read.
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('keeps a range and its focus choice, and leaves an earlier reveal alone when none is asked', async () => {
    const { store, file } = await openFiles()
    const target = { line: 2, column: 1, endLine: 2, endColumn: 4, focus: false }
    await store.openFile('/repo', '/repo/a.ts', target)
    const reveal = file('/repo/a.ts')?.pendingReveal
    expect(reveal).toMatchObject(target)
    await store.openFile('/repo', '/repo/a.ts')
    expect(file('/repo/a.ts')?.pendingReveal).toBe(reveal)
  })

  it('shows the source of HTML when asked for a place in it', async () => {
    const { store, file } = await openFiles()
    await store.openFile('/repo', '/repo/page.html')
    expect(file('/repo/page.html')?.view).toBeUndefined()
    await store.openFile('/repo', '/repo/page.html', { line: 1, column: 1 })
    expect(file('/repo/page.html')?.view).toBe('source')
  })

  it('opens one tab when two opens of a file overlap, at the place asked for last', async () => {
    const { useFilesStore, workspaceFiles } = await import('./files')
    const { store, file } = await openFiles()
    const reads: Array<() => void> = []
    invoke.mockImplementation(
      (_channel: string, path: string) =>
        new Promise((resolve) =>
          reads.push(() => resolve({ path, content: 'one\ntwo\n', size: 8, mtimeMs: 1 })),
        ),
    )
    const tabs = (path: string) =>
      workspaceFiles(useFilesStore.getState(), '/repo').openFiles.filter((f) => f.path === path)

    // The later read finishing first must not be overwritten by the earlier one.
    const earlier = store.openFile('/repo', '/repo/a.ts', 1)
    const later = store.openFile('/repo', '/repo/a.ts', 2)
    reads[1]!()
    await later
    reads[0]!()
    await earlier
    expect(tabs('/repo/a.ts')).toHaveLength(1)
    expect(file('/repo/a.ts')?.pendingReveal?.line).toBe(2)

    // In order, the later one's place still wins.
    const first = store.openFile('/repo', '/repo/b.ts', 1)
    const second = store.openFile('/repo', '/repo/b.ts', 2)
    reads[2]!()
    await first
    reads[3]!()
    await second
    expect(tabs('/repo/b.ts')).toHaveLength(1)
    expect(file('/repo/b.ts')?.pendingReveal?.line).toBe(2)
  })

  it('drops a pending reveal when the file moves, so the moved one is not jumped again', async () => {
    const { store, file } = await openFiles()
    await store.openFile('/repo', '/repo/a.ts', 2)
    store.reconcilePath('/repo', '/repo/a.ts', '/repo/b.ts')
    expect(file('/repo/b.ts')).toMatchObject({ relativePath: 'b.ts' })
    expect(file('/repo/b.ts')?.pendingReveal).toBeUndefined()
  })
})
