import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import { openMemoryStore } from '@phosphor/memory-engine/service'
import { createMemoryHandler } from './memory-worker-handler'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
it('rejects stale embedding completions atomically and refuses omitted manual consent epochs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'brain-db-adapter-'))
  directories.push(directory)
  const store = openMemoryStore({ directory, Database: loadSqlite().DatabaseSync })
  const handle = createMemoryHandler(store)
  const revision = store.snapshot()
  store.setPrefs({ ...revision.prefs, enabled: true })
  expect(handle({ id: 1, method: 'commitVectors', args: [revision, []] })).toEqual({
    id: 1,
    ok: true,
    data: false,
  })
  expect(
    handle({ id: 2, method: 'createJob', args: ['/repo', { provider: 'openai', id: 'm' }] }),
  ).toMatchObject({ ok: false })
  store.close()
})
