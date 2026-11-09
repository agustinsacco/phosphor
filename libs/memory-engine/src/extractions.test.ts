import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openBrainStore } from './store'
import { approve, extraction, fixture, lane, vector } from './test-support'
import { freshness } from './search'

it('migrates a populated v2 database in place, retaining every table row', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harbor-migration-'))
  const path = join(directory, 'brain.sqlite')
  try {
    const store = openBrainStore({ path, Database: DatabaseSync })
    approve(store)
    store.close()
    const old = new DatabaseSync(path)
    // Reconstruct the actual v2 shape, including approved citations and vectors.
    if (old.prepare('PRAGMA user_version').get()?.user_version === 3) {
      old.exec(
        'ALTER TABLE memories DROP COLUMN job_id; DROP TABLE extractions; PRAGMA user_version=2',
      )
    }
    const names = old
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name))
    const before = new Map(
      names.map((name) => [name, old.prepare(`SELECT * FROM "${name}"`).all()]),
    )
    old.close()
    const reopened = openBrainStore({ path, Database: DatabaseSync })
    expect(reopened.knowledge().memories).toHaveLength(2)
    expect(reopened.knowledge().memories.every((memory) => memory.jobId === null)).toBe(true)
    reopened.close()
    const migrated = new DatabaseSync(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 })
    for (const [name, rows] of before) {
      const after = migrated
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .map((row) => {
          if (name === 'memories') delete row.job_id
          return row
        })
      expect(after, name).toEqual(rows)
    }
    migrated.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('links approved memories to their extraction and retains it until its last memory is forgotten', () => {
  const { store } = fixture()
  const job = store.enqueue(lane(), 'queued')
  store.saveExtraction({
    jobId: job.id,
    sessionId: job.sessionId,
    sessionPath: job.sessionPath,
    title: job.title,
    leafId: job.leafId,
    model: job.model,
    thinking: 'low',
    prompt: 'Harbor instruction',
    answer: 'Harbor answer',
    trace: null,
    outcomes: [],
    error: null,
    startedAt: 1000,
    finishedAt: 1001,
  })
  store.propose(extraction(job.id))
  store.review(job.id, [0, 1], 0)
  const memories = store.knowledge().memories
  expect(memories.every((memory) => memory.jobId === job.id)).toBe(true)
  expect(store.extraction(job.id).memories).toHaveLength(2)
  store.forget(memories[0]!.id)
  expect(store.extraction(job.id).memories).toHaveLength(1)
  store.forget(memories[1]!.id)
  expect(() => store.extraction(job.id)).toThrow('Brain extraction not found')
})

it('freshness ages from the latest observed or already effective date, never a future effective date', () => {
  const { store } = fixture()
  approve(store)
  const memory = store.knowledge().memories[0]!
  const now = 200 * 86_400_000
  const base = { ...memory, type: 'fact' as const, observedAt: 0 }
  expect(freshness({ ...base, validFrom: 180 * 86_400_000 }, now)).toBeCloseTo(
    0.5 + 0.5 * 2 ** (-20 / 180),
  )
  expect(freshness({ ...base, validFrom: now + 1 }, now)).toBe(
    freshness({ ...base, validFrom: null }, now),
  )
  expect(freshness({ ...base, observedAt: now, validFrom: 1 }, now)).toBe(1)
})

it.each([null, [], [0]].map((keep) => ({ keep })))(
  'mixed proposals apply confirmations only with a nonempty approval: %j',
  ({ keep }) => {
    const { store } = fixture()
    approve(store)
    const old = store.knowledge().memories.find((memory) => memory.summary.includes('owns'))!
    const job = store.enqueue(lane({ leafId: 'next' }), 'queued')
    const data = extraction(job.id)
    data.evidence[0]!.observedAt = 9000
    data.vectors = [vector(1), vector(0, 0, 1)]
    expect(store.propose(data)).toMatchObject({ kept: 1, duplicates: 0, reconfirmed: 1 })
    expect(store.proposal(job.id).confirmations).toEqual([{ id: old.id, summary: old.summary }])
    expect(store.memory(old.id).memory.observedAt).toBe(10)
    store.review(job.id, keep, store.snapshot().revision)
    expect(store.memory(old.id).memory.observedAt).toBe(keep?.length ? 9000 : 10)
    expect(store.memory(old.id).quotes).toHaveLength(keep?.length ? 2 : 1)
  },
)

it.each([null, []].map((keep) => ({ keep })))(
  'confirmation-only jobs stay reviewable and [] approves while null rejects: %j',
  ({ keep }) => {
    const { store } = fixture()
    approve(store)
    const job = store.enqueue(lane({ leafId: 'next' }), 'queued')
    const data = extraction(job.id)
    data.evidence.forEach((evidence) => {
      evidence.observedAt = 9000
    })
    expect(store.propose(data)).toMatchObject({ kept: 0, duplicates: 0, reconfirmed: 2 })
    expect(store.job(job.id)?.state).toBe('review')
    store.review(job.id, keep, store.snapshot().revision)
    expect(store.knowledge().memories.every((memory) => memory.observedAt === 9000)).toBe(
      keep !== null,
    )
  },
)

it('counts a repeated confirmation in the same answer as a duplicate, not another reconfirmation', () => {
  const { store } = fixture()
  approve(store)
  const job = store.enqueue(lane({ leafId: 'next' }), 'queued')
  const data = extraction(job.id)
  data.memories = [data.memories[0]!, data.memories[0]!]
  data.vectors = [vector(1), vector(1)]
  const result = store.propose(data)
  expect(result).toMatchObject({ kept: 0, reconfirmed: 1, duplicates: 1 })
  expect(result.outcomes.map((item) => item.status)).toEqual(['reconfirms', 'duplicate'])
})

it.each(['dismiss', 'reject', 'expire'])(
  'retains inbox records until %s without expiring approved knowledge',
  (action) => {
    const { store, db } = fixture()
    const job = store.enqueue(lane(), 'queued')
    store.saveExtraction({
      jobId: job.id,
      sessionId: job.sessionId,
      sessionPath: job.sessionPath,
      title: job.title,
      leafId: job.leafId,
      model: job.model,
      thinking: 'low',
      prompt: 'Harbor instruction',
      answer: '',
      trace: null,
      outcomes: [],
      error: null,
      startedAt: 1000,
      finishedAt: 1001,
    })
    expect(store.extraction(job.id).jobId).toBe(job.id)
    if (action === 'dismiss') store.removeJob(job.id)
    else {
      store.propose(extraction(job.id))
      store.review(job.id, action === 'reject' ? null : [0], store.snapshot().revision)
      if (action === 'expire') {
        expect(store.extraction(job.id).memories).toHaveLength(1)
        db.prepare('UPDATE extractions SET finished_at=?').run(-31 * 86_400_000)
        expect(store.snapshot().counts.memories).toBe(1)
        expect(store.knowledge().memories[0]?.jobId).toBe(job.id)
      }
    }
    expect(() => store.extraction(job.id)).toThrow('Brain extraction not found')
  },
)

it('removes an empty job record on dismissal and preserves links for partially approved outcomes', () => {
  const { store } = fixture()
  const job = store.enqueue(lane(), 'queued')
  const base = {
    jobId: job.id,
    sessionId: job.sessionId,
    sessionPath: job.sessionPath,
    title: job.title,
    leafId: job.leafId,
    model: job.model,
    thinking: 'low',
    prompt: 'Harbor instruction',
    answer: '',
    trace: null,
    outcomes: [],
    error: null,
    startedAt: 1000,
    finishedAt: 1001,
  }
  store.saveExtraction(base)
  store.propose(extraction(job.id, { memories: [], vectors: [] }))
  expect(store.extraction(job.id).jobId).toBe(job.id)
  store.updateJob(job.id, { state: 'done' })
  expect(() => store.extraction(job.id)).toThrow('Brain extraction not found')
  const next = store.enqueue(lane({ leafId: 'next' }), 'queued')
  const data = extraction(next.id)
  const result = store.propose(data)
  store.saveExtraction({ ...base, jobId: next.id, outcomes: result.outcomes })
  store.review(next.id, [1], store.snapshot().revision)
  const record = store.extraction(next.id)
  expect(record.outcomes[0]?.memoryId).toBeUndefined()
  expect(record.outcomes[1]?.memoryId).toBe(record.memories[0]?.id)
})

it('resolves a within-proposal duplicate to the produced memory after approval', () => {
  const { store } = fixture()
  const job = store.enqueue(lane(), 'queued')
  const data = extraction(job.id)
  data.memories = [data.memories[0]!, data.memories[0]!]
  data.vectors = [vector(1), vector(1)]
  const result = store.propose(data)
  store.saveExtraction({
    jobId: job.id,
    sessionId: job.sessionId,
    sessionPath: job.sessionPath,
    title: job.title,
    leafId: job.leafId,
    model: job.model,
    thinking: 'low',
    prompt: 'Harbor instruction',
    answer: '',
    trace: null,
    outcomes: result.outcomes,
    error: null,
    startedAt: 1000,
    finishedAt: 1001,
  })
  store.review(job.id, [0], store.snapshot().revision)
  const record = store.extraction(job.id)
  expect(record.outcomes[1]?.memoryId).toBe(record.memories[0]!.id)
})
