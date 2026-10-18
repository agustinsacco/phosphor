import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFilesStore, workspaceFiles } from './files'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext', peekMonaco: () => null }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: () => {} }))
const invoke = vi.fn()
const store = () => useFilesStore.getState()
const file = () => workspaceFiles(store(), '/repo').openFiles[0]!
const snapshot = (content: string) => ({ content, size: content.length, mtimeMs: 1 })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  invoke.mockReset().mockResolvedValue(snapshot('disk'))
  vi.stubGlobal('window', { phosphor: { invoke } })
  useFilesStore.setState({ byWorkspace: {} })
  await store().openFile('/repo', '/repo/a.ts')
  invoke.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

it('marks only the written snapshot saved when typing continues during a save', async () => {
  const write = deferred<{ mtimeMs: number }>()
  invoke.mockReturnValue(write.promise)
  store().updateBuffer('/repo', '/repo/a.ts', 'first')
  const saving = store().saveFile('/repo', '/repo/a.ts')
  store().updateBuffer('/repo', '/repo/a.ts', 'newer')
  write.resolve({ mtimeMs: 2 })
  await saving
  expect(invoke).toHaveBeenCalledWith('fs:writeFile', '/repo/a.ts', 'first')
  expect(file()).toMatchObject({ content: 'newer', savedContent: 'first', dirty: true, size: 5 })
})

it('serializes overlapping saves in request order', async () => {
  const first = deferred<{ mtimeMs: number }>()
  const second = deferred<{ mtimeMs: number }>()
  invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  store().updateBuffer('/repo', '/repo/a.ts', 'first')
  const a = store().saveFile('/repo', '/repo/a.ts')
  store().updateBuffer('/repo', '/repo/a.ts', 'second')
  const b = store().saveFile('/repo', '/repo/a.ts')
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
  first.resolve({ mtimeMs: 2 })
  await a
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
  expect(file().dirty).toBe(true)
  second.resolve({ mtimeMs: 3 })
  await b
  expect(invoke.mock.calls.map((args) => args[2])).toEqual(['first', 'second'])
  expect(file()).toMatchObject({ savedContent: 'second', dirty: false })
})

it('retains dirty content on failure and permits retry', async () => {
  invoke.mockRejectedValueOnce(new Error('Disk full')).mockResolvedValueOnce({ mtimeMs: 2 })
  store().updateBuffer('/repo', '/repo/a.ts', 'edit')
  await expect(store().saveFile('/repo', '/repo/a.ts')).rejects.toThrow('Disk full')
  expect(file()).toMatchObject({ content: 'edit', savedContent: 'disk', dirty: true })
  await store().saveFile('/repo', '/repo/a.ts')
  expect(file().dirty).toBe(false)
})

it('does not overwrite edits made during a watcher reload', async () => {
  const read = deferred<ReturnType<typeof snapshot>>()
  invoke.mockReturnValue(read.promise)
  const reload = store().reloadFromDisk('/repo', '/repo/a.ts')
  store().updateBuffer('/repo', '/repo/a.ts', 'human edit')
  read.resolve(snapshot('agent edit'))
  await reload
  expect(file()).toMatchObject({ content: 'human edit', dirty: true, diskConflict: true })
})

it.each(['save', 'reload', 'failed reload'])(
  'does not apply an old %s to a reopened tab',
  async (action) => {
    const pending = deferred<ReturnType<typeof snapshot>>()
    invoke.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(snapshot('reopened'))
    if (action === 'save') store().updateBuffer('/repo', '/repo/a.ts', 'old edit')
    const operation =
      action === 'save'
        ? store().saveFile('/repo', '/repo/a.ts')
        : store().reloadFromDisk('/repo', '/repo/a.ts')
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    store().closeFile('/repo', '/repo/a.ts')
    await store().openFile('/repo', '/repo/a.ts')
    if (action === 'failed reload') pending.reject(new Error('Gone'))
    else pending.resolve(snapshot('old result'))
    await operation
    expect(file()).toMatchObject({ content: 'reopened', savedContent: 'reopened', dirty: false })
    expect(file().diskConflict).not.toBe(true)
  },
)
