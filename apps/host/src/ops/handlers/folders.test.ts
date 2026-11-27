import { expect, it } from 'vitest'
import { folderHandlers, folderUndoCurrent } from './folders'
import type { DaemonHandlerDeps } from './index'
it('serves the full list in inventory pages and echoes the continuation in data', async () => {
  const rows = Array.from({ length: 70 }, (_, id) => ({ id: String(id) }))
  const list = folderHandlers({
    store: { listRepositories: () => rows },
  } as unknown as DaemonHandlerDeps)['folder.list']!
  expect((await list({}, {} as never)).data).toEqual({ folders: rows.slice(0, 20), next: '20' })
  expect((await list({}, { page: '20' } as never)).data).toEqual({
    folders: rows.slice(20, 40),
    next: '40',
  })
})

it('pages the separate owner folder source without growing the legacy repository projection', async () => {
  const folders = Array.from({ length: 65 }, (_, i) => ({ id: String(i) }))
  const list = folderHandlers({
    ownerFolders: () => folders,
    store: { listRepositories: () => folders.slice(0, 64) },
  } as unknown as DaemonHandlerDeps)['folder.list']!
  expect((await list({}, { page: '64' } as never)).data).toEqual({
    folders: folders.slice(64),
    next: null,
  })
})

it('keeps the older 64-row surface pagination and data shape', async () => {
  const folders = Array.from({ length: 65 }, (_, i) => ({ id: String(i) }))
  const list = folderHandlers({ ownerFolders: () => folders } as unknown as DaemonHandlerDeps)[
    'folder.list'
  ]!
  const ctx = { principal: { kind: 'surface' } } as never
  expect(await list({}, ctx)).toMatchObject({
    next: '64',
    data: { folders: folders.slice(0, 64), next: '64' },
  })
})

it('only restores the old folder order while the order this change set is current', () => {
  const rows = [{ id: 'a' }, { id: 'b' }]
  const deps = { store: { listRepositories: () => rows } } as unknown as DaemonHandlerDeps
  const entry = {
    op: 'folder.order',
    undoRecord: { forward: { ids: ['a', 'b'] }, inverse: { args: { ids: ['b', 'a'] } } },
  } as never
  expect(folderUndoCurrent(deps, entry)).toBe(true)
  rows.reverse()
  expect(folderUndoCurrent(deps, entry)).toBe(false)
})

it('walks 65 folders through canonical cursors without repeating or losing rows', async () => {
  const folders = Array.from({ length: 65 }, (_, i) => ({ id: String(i), name: `Folder ${i}` }))
  const list = folderHandlers({ ownerFolders: () => folders } as unknown as DaemonHandlerDeps)[
    'folder.list'
  ]!
  const seen = []
  let page: string | undefined
  for (const next of ['20', '40', '60', undefined]) {
    const result = await list({}, { page } as never)
    expect(result.next).toBe(next)
    expect(result.text.split('\n')[0]).toBe('id | name | path')
    seen.push(...(result.data as { folders: typeof folders }).folders)
    page = result.next
  }
  expect(seen).toEqual(folders)
})
