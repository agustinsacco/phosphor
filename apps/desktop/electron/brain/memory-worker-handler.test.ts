import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
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
it('rejects an oversized response without poisoning later database operations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'brain-db-response-'))
  directories.push(directory)
  const store = openMemoryStore({ directory, Database: loadSqlite().DatabaseSync })
  const snapshot = store.snapshot()
  vi.spyOn(store, 'snapshot').mockReturnValueOnce({
    ...snapshot,
    entities: [
      {
        id: 'large',
        scope: '/repo',
        kind: 'component',
        label: '界'.repeat(3_000_000),
        aliases: [],
      },
    ],
  })
  const handle = createMemoryHandler(store)
  try {
    expect(handle({ id: 1, method: 'snapshot', args: [] })).toEqual({
      id: 1,
      ok: false,
      error: 'Brain database response exceeds limit',
    })
    expect(handle({ id: 2, method: 'snapshot', args: [] })).toEqual({
      id: 2,
      ok: true,
      data: snapshot,
    })
  } finally {
    store.close()
  }
})
