import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFilesStore, workspaceFiles } from '@/stores/files'
import { usePromptStore } from '@/stores/prompt'
import { closeEditorFile } from './closeEditorFile'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./MonacoEditor', () => ({ releaseFileModel: () => {} }))
const invoke = vi.fn()
const store = () => useFilesStore.getState()
const file = () => workspaceFiles(store(), '/repo').openFiles[0]
const choose = (value?: string) => {
  const request = usePromptStore.getState().requests[0]!
  usePromptStore.getState().dismiss(request, value)
}

beforeEach(async () => {
  vi.stubGlobal('window', { phosphor: { invoke } })
  invoke.mockReset().mockResolvedValue({ content: 'disk', size: 4, mtimeMs: 1 })
  useFilesStore.setState({ byWorkspace: {} })
  usePromptStore.setState({ requests: [] })
  await store().openFile('/repo', '/repo/a.ts')
  store().updateBuffer('/repo', '/repo/a.ts', 'unsaved')
})
afterEach(() => vi.unstubAllGlobals())

it('Cancel preserves the buffer and deduplicates repeated close requests', async () => {
  const first = closeEditorFile('/repo', '/repo/a.ts')
  expect(closeEditorFile('/repo', '/repo/a.ts')).toBe(first)
  expect(usePromptStore.getState().requests).toHaveLength(1)
  choose()
  expect(await first).toBe(false)
  expect(file()?.content).toBe('unsaved')
})

it('Save writes before closing', async () => {
  const closing = closeEditorFile('/repo', '/repo/a.ts')
  choose('save')
  expect(await closing).toBe(true)
  expect(invoke).toHaveBeenCalledWith('fs:writeFile', '/repo/a.ts', 'unsaved')
  expect(file()).toBeUndefined()
})

it('Don’t Save closes without writing', async () => {
  const closing = closeEditorFile('/repo', '/repo/a.ts')
  choose('discard')
  expect(await closing).toBe(true)
  expect(invoke.mock.calls.some(([channel]) => channel === 'fs:writeFile')).toBe(false)
})

it('a failed save keeps the tab dirty and rejects for visible error handling', async () => {
  invoke.mockRejectedValueOnce(new Error('Read only'))
  const closing = closeEditorFile('/repo', '/repo/a.ts')
  choose('save')
  await expect(closing).rejects.toThrow('Read only')
  expect(file()).toMatchObject({ dirty: true, content: 'unsaved' })
})

it('does not discard a newer edit while the prompt is open', async () => {
  const closing = closeEditorFile('/repo', '/repo/a.ts')
  store().updateBuffer('/repo', '/repo/a.ts', 'new edit')
  choose('discard')
  expect(await closing).toBe(false)
  expect(file()?.content).toBe('new edit')
})

it('keeps edits made while the final save is running', async () => {
  let finish!: (value: { mtimeMs: number }) => void
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const closing = closeEditorFile('/repo', '/repo/a.ts')
  choose('save')
  await vi.waitFor(() => expect(finish).toBeDefined())
  store().updateBuffer('/repo', '/repo/a.ts', 'new edit')
  finish({ mtimeMs: 2 })
  expect(await closing).toBe(false)
  expect(file()).toMatchObject({ dirty: true, content: 'new edit' })
})

it('closes a clean file without prompting', async () => {
  store().updateBuffer('/repo', '/repo/a.ts', 'disk')
  expect(await closeEditorFile('/repo', '/repo/a.ts')).toBe(true)
  expect(usePromptStore.getState().requests).toHaveLength(0)
})
