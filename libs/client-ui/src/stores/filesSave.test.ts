import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachFilesSource, useFilesStore, workspaceFiles } from './files'
import type { FilesSource } from '@/features/files/filesSource'

vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: () => {} }))
const lane = 'host:h/lane:l'
const path = `${lane}/a.ts`
const invoke = vi.fn()
const store = () => useFilesStore.getState()
const file = () => workspaceFiles(store(), lane).openFiles[0]!
const writes = () => invoke.mock.calls.filter(([channel]) => channel === 'fs:writeFile')
const attach = (writeRefusal: string | null = null) =>
  attachFilesSource({ workspacePath: lane, listing: 'flat', writeRefusal } as FilesSource)

beforeEach(async () => {
  invoke.mockReset().mockResolvedValue({ content: 'disk', size: 4, mtimeMs: 1, revision: 'r1' })
  vi.stubGlobal('window', { phosphor: { invoke } })
  useFilesStore.setState({ byWorkspace: {} })
  attach()
  await store().openFile(lane, path)
  store().updateBuffer(lane, path, 'edited')
})
afterEach(() => {
  store().releaseWorkspace(lane)
  vi.unstubAllGlobals()
})

it('saves over the revision it read and keeps the one the Host returns', async () => {
  invoke.mockResolvedValueOnce({ mtimeMs: 2, revision: 'r2' })
  await store().saveFile(lane, path)
  expect(writes()).toEqual([['fs:writeFile', path, 'edited', 'r1']])
  expect(file()).toMatchObject({ revision: 'r2', savedContent: 'edited', dirty: false })
  expect(file().saving).toBe(false)
})

it('sends nothing more while a save is in flight', async () => {
  let settle!: (value: unknown) => void
  invoke.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
  const saving = store().saveFile(lane, path)
  expect(file().saving).toBe(true)
  await store().saveFile(lane, path)
  settle({ mtimeMs: 2, revision: 'r2' })
  await saving
  expect(writes()).toHaveLength(1)
})

it('keeps the buffer on a conflict and flags it', async () => {
  invoke.mockRejectedValueOnce(new Error('changed-on-disk'))
  await store().saveFile(lane, path)
  expect(file()).toMatchObject({ content: 'edited', dirty: true, diskConflict: true })
  expect(file().saveUncertain).toBeUndefined()
})

it('never retries an uncertain save until the file is reloaded', async () => {
  invoke.mockRejectedValueOnce(new Error('timeout'))
  await store().saveFile(lane, path)
  expect(file()).toMatchObject({ content: 'edited', dirty: true, saveUncertain: true })
  await store().saveFile(lane, path)
  expect(writes()).toHaveLength(1)
  invoke.mockResolvedValueOnce({ content: 'landed', size: 6, mtimeMs: 3, revision: 'r3' })
  await store().reloadFromDisk(lane, path)
  expect(file()).toMatchObject({ content: 'landed', revision: 'r3', saveUncertain: false })
})

it('refuses with the source’s write refusal before sending', async () => {
  attach('Take control first.')
  await expect(store().saveFile(lane, path)).rejects.toThrow('Take control first.')
  expect(writes()).toHaveLength(0)
  expect(file().dirty).toBe(true)
})
