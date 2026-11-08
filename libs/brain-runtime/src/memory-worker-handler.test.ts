import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import { openMemoryStore } from '@phosphor/memory-engine/service'
import { createMemoryHandler } from './memory-worker-handler'
import { MEMORY_METHODS } from './memory-protocol'

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
it('exposes every durable operation through the worker without dropping learning receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'brain-learning-dispatch-'))
  directories.push(directory)
  const store = openMemoryStore({ directory, Database: loadSqlite().DatabaseSync })
  try {
    expect([...MEMORY_METHODS].sort()).toEqual(
      [...Object.keys(store), 'captureAt', 'commitVectors'].sort(),
    )
    expect(createMemoryHandler(store)({ id: 1, method: 'learningJobs', args: [] })).toEqual({
      id: 1,
      ok: true,
      data: { items: [], truncated: false },
    })
  } finally {
    store.close()
  }
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

it('queries durable recipient and processor exclusion even after preferences are disabled', () => {
  const directory = mkdtempSync(join(tmpdir(), 'brain-exclusion-query-'))
  directories.push(directory)
  let store = openMemoryStore({ directory, Database: loadSqlite().DatabaseSync })
  const model = { provider: 'openai', id: 'synthetic' }
  store.setPrefs({
    ...store.snapshot().prefs,
    enabled: true,
    recall: true,
    workspaces: ['/repo'],
    processor: model,
  })
  const evidence = store.capture({
    scope: '/repo',
    sessionId: 'clean',
    entryId: 'entry',
    parentId: null,
    rootIds: ['entry'],
    branch: null,
    role: 'user',
    label: 'Synthetic',
    observedAt: Date.now(),
    text: 'Synthetic independent evidence',
  })!
  store.recordDelivery({ sessionId: 'empty-recipient', evidenceIds: [], claimIds: [] })
  store.recordDelivery({
    sessionId: 'nonempty-recipient',
    evidenceIds: [evidence.id],
    claimIds: [],
  })
  const job = store.claimJob(store.createJob('/repo', model, store.snapshot().policyEpoch).id)
  const processorId = '11111111-2222-4333-8444-555555555555'
  store.updateJob(job.id, job.fence, { sessionPath: `/private/2026-11-06_${processorId}.jsonl` })
  store.setPrefs({ ...store.snapshot().prefs, enabled: false, recall: false })
  const before = store.snapshot()
  store.close()
  store = openMemoryStore({ directory, Database: loadSqlite().DatabaseSync })
  try {
    const handle = createMemoryHandler(store)
    for (const id of ['empty-recipient', 'nonempty-recipient', processorId, job.id])
      expect(handle({ id: 1, method: 'excludedSource', args: [id] })).toEqual({
        id: 1,
        ok: true,
        data: true,
      })
    expect(handle({ id: 2, method: 'excludedSource', args: ['clean'] })).toEqual({
      id: 2,
      ok: true,
      data: false,
    })
    expect(handle({ id: 3, method: 'excludedSource', args: [''] })).toMatchObject({ ok: false })
    expect(store.snapshot()).toEqual(before)
  } finally {
    store.close()
  }
})
