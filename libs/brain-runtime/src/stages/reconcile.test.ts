import { trackAsk } from '../__fixtures__/stage-ask'
import { expect, it } from 'vitest'
import type { ProposalMemory, ProposalEntity, MemoryCard } from '@phosphor/memory-engine/types'
import { FakeBrainStore, FakeBrainSearch } from '../__fixtures__/fake-store'
import type { StageAsk } from '../stage-types'
import { reconcile } from './reconcile'
import type { FoldedJob } from './fold'
const memory = (summary: string): ProposalMemory => ({
  summary,
  type: 'fact',
  kind: 'reported',
  entities: ['project'],
  links: [],
  citations: [{ evidence: 0, quote: summary }],
  branch: false,
  validFrom: null,
  validTo: null,
  action: 'add',
  target: null,
  reason: '',
})
const old = (summary: string): MemoryCard => ({
  id: 'old',
  jobId: null,
  summary,
  type: 'fact',
  kind: 'reported',
  state: 'active',
  entityIds: ['project'],
  links: [],
  scope: '/harbor',
  branch: null,
  validFrom: null,
  validTo: null,
  recordedAt: 0,
  observedAt: 0,
  origin: null,
})
const job = (memories: ProposalMemory[]): FoldedJob => ({
  entities: [],
  claims: memories.map((memory, i) => ({ ref: `c${i + 1}`, memory })),
  parents: [],
  evidence: [],
  outcomes: [],
})
const identities: ProposalEntity[] = []
it('high cosine with negation is not deterministic confirmation', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch(),
    j = job([memory('Harbor does not bill weekly.')])
  store.oldMemories = [old('Harbor bills weekly.')]
  search.memoryNeighbours = [[{ id: 'old', score: 0.99 }]]
  const ask = trackAsk(async (_s, _p, _prompt, validate) =>
    validate(
      JSON.stringify({
        decisions: [{ ref: 'c1', action: 'conflict', target: 'M1', reason: 'Negation' }],
      }),
    ),
  )
  const confirmations = await reconcile(
    j,
    identities,
    store,
    search,
    [new Float32Array([1])],
    ask.ask,
  )
  expect(ask.spy).toHaveBeenCalledOnce()
  expect(confirmations).toEqual([])
  expect(j.claims[0]!.memory.action).toBe('conflict')
})
it('same sentence with different endpoints reaches Call 4 instead of confirming', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch(),
    m = memory('Harbor has an owner.')
  m.links = [
    {
      subject: 'person-2',
      predicate: 'owns',
      object: 'project',
      citation: { evidence: 0, quote: 'owner' },
    },
  ]
  const card = old(m.summary)
  card.links = [
    { id: 'r', subjectId: 'person-1', predicate: 'owns', objectId: 'project', memoryId: 'old' },
  ]
  store.oldMemories = [card]
  search.memoryNeighbours = [[{ id: 'old', score: 1 }]]
  const ask = trackAsk(async (_s, _p, _prompt, validate) =>
    validate(
      JSON.stringify({
        decisions: [{ ref: 'c1', action: 'add', target: null, reason: 'Different owner' }],
      }),
    ),
  )
  expect(
    await reconcile(job([m]), identities, store, search, [new Float32Array([1])], ask.ask),
  ).toEqual([])
  expect(ask.spy).toHaveBeenCalledOnce()
})
it('confirms only equal folded text and links without a model call', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch(),
    m = memory('Harbor bills weekly.')
  store.oldMemories = [old(m.summary)]
  store.matchesMemory = [['old']]
  const j = job([m]),
    ask = trackAsk()
  expect(await reconcile(j, identities, store, search, [new Float32Array([1])], ask.ask)).toEqual([
    { memoryId: 'old', claim: m, vector: new Float32Array([1]) },
  ])
  expect(j.claims).toEqual([])
  expect(ask.spy).not.toHaveBeenCalled()
})
it('later local monthly billing replaces weekly billing with a recorded outcome', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch(),
    j = job([memory('Harbor bills weekly.'), memory('Harbor now bills monthly.')])
  const ask: StageAsk = async (_s, _p, _prompt, validate) =>
    validate(
      JSON.stringify({
        decisions: [
          { ref: 'c2', action: 'supersede', target: 'M1', reason: 'Explicit local change' },
        ],
      }),
    )
  await reconcile(j, identities, store, search, [new Float32Array([1]), new Float32Array([1])], ask)
  expect(j.claims.map((c) => c.memory.summary)).toEqual(['Harbor now bills monthly.'])
  expect(j.outcomes).toContainEqual(
    expect.objectContaining({
      candidate: 'c1',
      status: 'dropped',
      reason: 'superseded later in this lane',
    }),
  )
})
it('refuses unoffered targets and malformed add decisions', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch()
  store.oldMemories = [old('Different')]
  store.matchesMemory = [['old']]
  const ask: StageAsk = async (_s, _p, _prompt, validate) =>
    validate(
      JSON.stringify({
        decisions: [{ ref: 'c1', action: 'add', target: 'M1', reason: 'invalid' }],
      }),
    )
  await expect(
    reconcile(job([memory('Harbor')]), identities, store, search, [new Float32Array([1])], ask),
  ).rejects.toThrow('Unoffered')
})

it('records a dropped local conflict as contradicted, not superseded', async () => {
  const j = job([memory('Harbor bills weekly.'), memory('Harbor never bills weekly.')])
  const ask: StageAsk = async (_s, _p, _prompt, validate) =>
    validate(
      JSON.stringify({
        decisions: [{ ref: 'c2', action: 'conflict', target: 'M1', reason: 'Contradiction' }],
      }),
    )
  await reconcile(
    j,
    [],
    new FakeBrainStore(),
    new FakeBrainSearch(),
    [new Float32Array([1]), new Float32Array([1])],
    ask,
  )
  expect(j.claims.map((c) => c.ref)).toEqual(['c2'])
  expect(j.outcomes).toContainEqual(
    expect.objectContaining({
      candidate: 'c1',
      status: 'dropped',
      reason: 'contradicted later in this lane',
    }),
  )
})

it('folds a later exact duplicate even when many earlier claims share its entities', async () => {
  const claim = (summary: string, entities: string[]): ProposalMemory => ({
    ...memory(summary),
    entities,
  })
  const j = job([
    claim('Kestrel is part of Harbor.', ['kestrel', 'harbor']),
    ...[1, 2, 3, 4, 5, 6].map((i) => claim(`Kestrel fact ${i}.`, ['kestrel', `thing-${i}`])),
    claim('Kestrel is part of Harbor.', ['kestrel', 'harbor']),
  ])
  const offered: string[] = []
  const ask = trackAsk(async (_s, _p, _prompt, validate, _ids, input) => {
    const rows = (input as { rows: { claim: { ref: string } }[] }).rows
    offered.push(...rows.map((row) => row.claim.ref))
    return validate(
      JSON.stringify({
        decisions: rows.map((row) => ({
          ref: row.claim.ref,
          action: 'add',
          target: null,
          reason: 'New',
        })),
      }),
    )
  })
  const vectors = j.claims.map(() => new Float32Array([1]))
  await reconcile(j, [], new FakeBrainStore(), new FakeBrainSearch(), vectors, ask.ask)
  expect(offered).not.toContain('c8')
  expect(j.claims.map((c) => c.ref)).not.toContain('c8')
  expect(j.outcomes).toContainEqual(
    expect.objectContaining({ candidate: 'c8', status: 'folded', reason: 'merged into c1' }),
  )
})
