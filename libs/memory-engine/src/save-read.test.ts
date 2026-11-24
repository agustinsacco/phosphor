import { expect, it } from 'vitest'
import { BRAIN_TEMPORARY_DAYS } from '@phosphor/shared/brain'
import { BRAIN_READ_STALE } from './read-stale'
import { approve, extraction, fixture, lane, running, save, vector } from './test-support'
import { seed } from './tidy/test-support'

const DAY = 86_400_000

it('saves a temporary claim with an end 14 days after it was said, its links ending with it', () => {
  const { store, db } = fixture()
  const data = extraction('unused')
  const saved = save(store, {
    memories: [{ ...data.memories[0]!, hold: 'temporary' }, data.memories[1]!],
  })
  expect(saved).toMatchObject({ state: 'done', memories: 2, temporary: 1, personal: 0 })
  const end = 10 + BRAIN_TEMPORARY_DAYS * DAY
  expect(
    db
      .prepare('SELECT summary,valid_to FROM memories ORDER BY n')
      .all()
      .map((r) => r.valid_to),
  ).toEqual([end, null])
  expect(
    db
      .prepare('SELECT predicate,valid_to FROM relations ORDER BY n')
      .all()
      .map((r) => [r.predicate, r.valid_to]),
  ).toEqual([
    ['owns', end],
    ['works_on', null],
  ])
})
it('keeps a temporary claim from replacing a lasting memory: it saves beside it', () => {
  const { store } = fixture()
  const [target] = approve(store)
  const data = extraction('unused')
  const saved = save(store, {
    origin: { sessionId: 'ledger-lane', title: 'Ledger' },
    memories: [{ ...data.memories[0]!, hold: 'temporary', action: 'supersede', target: target! }],
    memoryVectors: [vector()],
  })
  expect(saved.memories).toBe(1)
  expect(store.memory(target!).memory.state).toBe('active')
})
it('never saves a personal claim or repeat, and counts them', () => {
  const { store } = fixture()
  const data = extraction('unused')
  const saved = save(store, {
    memories: [{ ...data.memories[0]!, hold: 'personal' }, data.memories[1]!],
  })
  expect(saved).toMatchObject({ memories: 1, personal: 1 })
  expect(store.snapshot().counts.memories).toBe(1)
  const only = save(store, {
    memories: [{ ...data.memories[0]!, hold: 'personal' }],
    memoryVectors: [vector()],
  })
  expect(only).toMatchObject({ state: 'empty', operationId: null, personal: 1 })
})
it('refuses a stale read and one not in progress, changing nothing', () => {
  const { store } = fixture()
  const jobId = running(store)
  approve(store, { origin: { sessionId: 'ledger-lane', title: 'Ledger' } })
  expect(() => store.saveRead(extraction(jobId, { computedRevision: 0 }))).toThrow(BRAIN_READ_STALE)
  expect(store.job(jobId)?.state).toBe('running')
  const queued = store.enqueue(lane({ sessionId: 'kestrel-lane' }), 'queued')
  expect(() =>
    store.saveRead(extraction(queued.id, { computedRevision: store.knowledgeRevision() })),
  ).toThrow('Only a read in progress can be saved.')
})
it('saves an unsure identity as a new record with one guess, and reuses it on the next read (F16)', () => {
  const { store, db } = fixture()
  seed(db, 1)
  const unsure = () => {
    const data = extraction('unused')
    return data.entities.map((item) =>
      item.ref === 'rina'
        ? { ...item, decision: 'uncertain' as const, entityId: null, candidates: ['rina-1'] }
        : item,
    )
  }
  const first = save(store, { entities: unsure() })
  expect(first.guesses).toBe(1)
  const second = save(store, { entities: unsure() })
  expect(second.guesses).toBe(0)
  const rinas = db.prepare("SELECT id FROM entities WHERE label='Rina Okafor'").all()
  expect(rinas).toHaveLength(2)
  expect(
    db
      .prepare(
        "SELECT kind,second_id,json_extract(detail,'$.kind') AS detail FROM tidy_suggestions WHERE source='read'",
      )
      .all(),
  ).toEqual([{ kind: 'same_entity', second_id: 'rina-1', detail: 'guess' }])
})
it('marks the owner once and never moves the mark', () => {
  const { store } = fixture()
  const data = extraction('unused')
  save(store, {
    entities: data.entities.map((item) => (item.ref === 'rina' ? { ...item, owner: true } : item)),
  })
  const owner = store.owner()!
  expect(store.entity(owner).entity.label).toBe('Rina Okafor')
  expect(store.snapshot().ownerId).toBe(owner)
  save(store, {
    origin: { sessionId: 'ledger-lane', title: 'Ledger' },
    entities: data.entities.map((item) => (item.ref === 'tom' ? { ...item, owner: true } : item)),
  })
  expect(store.owner()).toBe(owner)
  store.setOwner(null)
  expect(store.owner()).toBeNull()
})
it('Read again keeps a memory whose link Brain Agent stated (F9)', () => {
  const { store, db } = fixture()
  const first = save(store)
  const [host] = db.prepare("SELECT n,id FROM memories WHERE summary LIKE 'Rina%'").all() as {
    n: number
    id: string
  }[]
  db.prepare("UPDATE relations SET stated_by='agent' WHERE memory=?").run(host!.n)
  const next = running(store, { replaces: first.jobId, leafId: 'leaf-again' })
  const saved = store.saveRead(extraction(next, { computedRevision: store.knowledgeRevision() }))
  expect(saved.replaced).toBe(1)
  expect(store.memory(host!.id).memory.state).toBe('active')
})
it('answers stale, not invalid, when a target left Brain after the reader compared', () => {
  const { store } = fixture()
  const [target] = approve(store)
  const jobId = running(store, { sessionId: 'ledger-lane', leafId: 'leaf-stale' })
  const computedRevision = store.knowledgeRevision()
  store.erase(target!, { runId: null, reason: 'A test conversation made this up.' })
  const data = extraction(jobId, {
    computedRevision,
    origin: { sessionId: 'ledger-lane', title: 'Ledger' },
  })
  data.memories[0] = { ...data.memories[0]!, action: 'supersede', target: target! }
  expect(() => store.saveRead(data)).toThrow(BRAIN_READ_STALE)
  expect(store.job(jobId)?.state).toBe('running')
})
it('ends a temporary claim that starts later 14 days after its start, and each link after its own', () => {
  const { store, db } = fixture()
  const [claim] = extraction('unused').memories
  const start = 10 + 30 * DAY,
    linkStart = 10 + 35 * DAY
  const owns = claim!.links[0]!
  save(store, {
    memories: [
      {
        ...claim!,
        hold: 'temporary',
        validFrom: start,
        links: [
          { ...owns, validFrom: linkStart },
          { ...owns, predicate: 'works_on', label: 'works on' },
        ],
      },
    ],
    memoryVectors: [vector()],
  })
  const span = BRAIN_TEMPORARY_DAYS * DAY
  expect(db.prepare('SELECT valid_to FROM memories').get()).toEqual({ valid_to: start + span })
  expect(
    db
      .prepare('SELECT predicate,valid_to FROM relations ORDER BY n')
      .all()
      .map((r) => [r.predicate, r.valid_to]),
  ).toEqual([
    ['owns', linkStart + span],
    ['works_on', start + span],
  ])
})
