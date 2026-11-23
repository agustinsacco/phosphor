import { expect, it } from 'vitest'
import { folderHandlers } from './folders'
import type { DaemonHandlerDeps } from './index'
it('serves the full list in legacy-sized pages with the continuation in data', async () => {
  const rows = Array.from({ length: 70 }, (_, id) => ({ id: String(id) }))
  const list = folderHandlers({
    store: { listRepositories: () => rows },
  } as unknown as DaemonHandlerDeps)['folder.list']!
  expect((await list({}, {} as never)).data).toEqual({ folders: rows.slice(0, 64), next: '64' })
  expect((await list({}, { page: '64' } as never)).data).toEqual({
    folders: rows.slice(64),
    next: null,
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
