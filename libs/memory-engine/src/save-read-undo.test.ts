import { expect, it } from 'vitest'
import { extraction, fixture, lane, save } from './test-support'
import { seed } from './tidy/test-support'
import type { ProposalEntity } from './types'

const note = { runId: null, reason: 'These claims came from a test conversation.' }

it('undoing a saved read leaves the read rejected with nothing saved, its record kept, and Read again offered', () => {
  const { store, db } = fixture()
  const saved = save(store)
  const job = store.job(saved.jobId)!
  store.saveExtraction({
    jobId: job.id,
    sessionId: job.sessionId,
    sessionPath: job.sessionPath,
    title: job.title,
    leafId: job.leafId,
    model: job.model,
    thinking: 'off',
    calls: [],
    outcomes: [],
    error: null,
    startedAt: 100,
    finishedAt: 200,
  })
  store.agentUndo(saved.operationId!, note)
  expect(store.job(saved.jobId)).toMatchObject({ state: 'rejected', memories: 0 })
  expect(store.snapshot().counts.memories).toBe(0)
  expect(() => store.extraction(saved.jobId)).not.toThrow()
  expect(store.laneRead('harbor-lane')?.job.id).toBe(saved.jobId)
  const again = store.enqueue(lane({ replaces: saved.jobId }), 'queued')
  expect(again.replaces).toBe(saved.jobId)
  expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='running'").get()).toEqual({
    n: 0,
  })
})
it('a saved read closes the read questions it opened when it is undone', () => {
  const { store } = fixture()
  const saved = save(store, {
    groups: [
      {
        parent: { label: 'Harbor group', kind: 'organization', entityId: null },
        members: ['harbor', 'rina', 'tom'],
      },
    ],
  })
  expect(store.waitingCounts().groups).toBe(1)
  store.agentUndo(saved.operationId!, note)
  expect(store.waitingCounts().groups).toBe(0)
  expect(() => store.enqueue(lane({ leafId: 'leaf-again' }), 'queued')).not.toThrow()
})
it('undoing a read that reused a pending guess restores the guess record (names, keys, description, vector)', () => {
  const { store, db } = fixture()
  seed(db, 1)
  const unsure = (patch: Partial<ProposalEntity>) =>
    extraction('unused').entities.map((item) =>
      item.ref === 'rina'
        ? {
            ...item,
            decision: 'uncertain' as const,
            entityId: null,
            candidates: ['rina-1'],
            ...patch,
          }
        : item,
    )
  save(store, { entities: unsure({}) })
  const guess = db
    .prepare("SELECT n FROM entities WHERE label='Rina Okafor' AND id<>'rina-1'")
    .get() as { n: number }
  const image = () => ({
    entity: db.prepare('SELECT label,description FROM entities WHERE n=?').all(guess.n),
    names: db.prepare('SELECT name FROM entity_names WHERE entity=? ORDER BY name').all(guess.n),
    keys: db.prepare('SELECT namespace,value FROM entity_keys WHERE entity=?').all(guess.n),
    vector: db.prepare('SELECT vector FROM entity_vectors WHERE entity=?').all(guess.n),
  })
  const before = image()
  const second = save(store, {
    origin: { sessionId: 'ledger-lane', title: 'Ledger' },
    entities: unsure({
      aliases: ['R. Okafor'],
      keys: [{ namespace: 'github', value: 'rokafor' }],
      description: 'Ledger billing lead.',
    }),
  })
  expect(image()).not.toEqual(before)
  store.agentUndo(second.operationId!, note)
  expect(image()).toEqual(before)
})
