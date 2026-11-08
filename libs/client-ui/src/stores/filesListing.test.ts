import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachFilesSource, useFilesStore } from './files'
import type { FilesSource } from '@/features/files/filesSource'

vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: () => {} }))
const lane = 'host:h/lane:l'
const invoke = vi.fn()
const store = () => useFilesStore.getState()
const lists = () => invoke.mock.calls.filter(([channel]) => channel === 'fs:listFiles').length
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

it('lists a flat workspace once and fills every folder', async () => {
  await store().refreshDir(lane, `${lane}/src`)
  expect(invoke.mock.calls).toEqual([['fs:listFiles', lane]])
  expect(names(lane)).toEqual(['src', 'b.md'])
  expect(names(`${lane}/src`)).toEqual(['a.ts'])
  await store().toggleDir(lane, `${lane}/src`)
  await store().refreshLoadedDirs(lane)
  expect(lists()).toBe(2)
})

it('shares a list in flight and lists once more for requests made meanwhile', async () => {
  let settle!: (files: string[]) => void
  invoke.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
  const first = store().refreshDir(lane, lane)
  const second = store().refreshDir(lane, lane)
  const third = store().refreshLoadedDirs(lane)
  settle(['old.ts'])
  await Promise.all([first, second, third])
  expect(lists()).toBe(2)
  expect(names(lane)).toEqual(['src', 'b.md'])
})

it('drops vanished folders and their expansion, and keeps the rest', async () => {
  useFilesStore.setState({
    expanded: { [`${lane}/gone`]: true, [`${lane}/src`]: true, '/x': true },
  })
  await store().refreshDir(lane, lane)
  expect(store().expanded).toEqual({ [`${lane}/src`]: true, '/x': true })
})

it('names a failed list and keeps the tree it had', async () => {
  await store().refreshDir(lane, lane)
  invoke.mockRejectedValueOnce(new Error('boom'))
  await store().refreshDir(lane, lane)
  expect(store().listErrors[lane]).toBe('Could not read files.')
  expect(names(lane)).toEqual(['src', 'b.md'])
  await store().refreshDir(lane, lane)
  expect(store().listErrors[lane]).toBeUndefined()
})

it('refuses a list past the fold’s caps instead of drawing part of it', async () => {
  invoke.mockResolvedValueOnce([Array(65).fill('a').join('/')])
  await store().refreshDir(lane, lane)
  expect(store().listErrors[lane]).toBe('Not available on remote lanes yet.')
  expect(names(lane)).toEqual([])
})

it('reads a tree workspace one folder at a time, as before', async () => {
  invoke.mockResolvedValue([])
  await store().refreshDir('/repo', '/repo/src')
  expect(invoke.mock.calls[0]?.[0]).toBe('fs:readDir')
})
