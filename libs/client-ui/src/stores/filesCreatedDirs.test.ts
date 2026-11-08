import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachFilesSource, useFilesStore, workspaceFiles } from './files'
import type { FilesSource } from '@/features/files/filesSource'

vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: () => {} }))
const lane = 'host:h/lane:l'
const invoke = vi.fn()
const store = () => useFilesStore.getState()
const names = (dir: string) => store().entries[dir]?.map((entry) => entry.name)

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(['src/a.ts', 'b.md'])
  vi.stubGlobal('window', { phosphor: { invoke } })
  useFilesStore.setState({ entries: {}, expanded: {}, listErrors: {} })
  attachFilesSource({ workspacePath: lane, listing: 'flat', writeRefusal: null } as FilesSource)
})
afterEach(() => {
  store().releaseWorkspace(lane)
  vi.unstubAllGlobals()
})

const made = () => workspaceFiles(store(), lane).createdDirs

it('shows a folder made on a flat listing, with an empty listing of its own', async () => {
  store().addCreatedDir(lane, `${lane}/new`)
  store().addCreatedDir(lane, `${lane}/src/inner`)
  await store().refreshDir(lane, lane)
  expect(names(lane)).toEqual(['new', 'src', 'b.md'])
  expect(names(`${lane}/new`)).toEqual([])
  expect(names(`${lane}/src`)).toEqual(['inner', 'a.ts'])
})

it('moves a made folder and the made folders below it with a rename or move', async () => {
  store().addCreatedDir(lane, `${lane}/p`)
  store().addCreatedDir(lane, `${lane}/p/q`)
  store().addCreatedDir(lane, `${lane}/pq`)
  store().reconcilePath(lane, `${lane}/p`, `${lane}/r`)
  expect(made()).toEqual([`${lane}/r`, `${lane}/r/q`, `${lane}/pq`])
  await store().refreshDir(lane, lane)
  expect(names(`${lane}/r`)).toEqual(['q'])
})

it('forgets a trashed made folder and the made folders below it', async () => {
  store().addCreatedDir(lane, `${lane}/p`)
  store().addCreatedDir(lane, `${lane}/p/q`)
  store().addCreatedDir(lane, `${lane}/pq`)
  store().reconcilePath(lane, `${lane}/p`)
  expect(made()).toEqual([`${lane}/pq`])
})

it('drops a made folder once the list shows it, so the list then decides', async () => {
  store().addCreatedDir(lane, `${lane}/new`)
  invoke.mockResolvedValueOnce(['new/x.ts'])
  await store().refreshDir(lane, lane)
  expect(made()).toEqual([])
  expect(names(lane)).toEqual(['new'])
  await store().refreshDir(lane, lane)
  expect(names(lane)).toEqual(['src', 'b.md'])
})

it('drops made folders with the workspace', () => {
  store().addCreatedDir(lane, `${lane}/new`)
  store().releaseWorkspace(lane)
  expect(made()).toBeUndefined()
})

it('records no made folder on a tree listing, which lists folders itself', () => {
  store().addCreatedDir('/repo', '/repo/new')
  expect(workspaceFiles(store(), '/repo').createdDirs).toBeUndefined()
})
