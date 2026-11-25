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
  lanes: 1,
  saidBy: 'you',
  importance: 1,
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
it('same sentence with different endpoints reaches reconciliation instead of confirming', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch(),
    m = memory('Harbor has an owner.')
  m.links = [
    {
      subject: 'person-2',
      predicate: 'owns',
      object: 'project',
      label: '',
      citation: { evidence: 0, quote: 'owner' },
    },
  ]
  const card = old(m.summary)
  card.links = [
    {
      id: 'r',
      label: '',
      validFrom: null,
      validTo: null,
      statedBy: 'reader',
      subjectId: 'person-1',
      predicate: 'owns',
      objectId: 'project',
      memoryId: 'old',
    },
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
  const j = job([memory('Harbor')])
  await reconcile(j, identities, store, search, [new Float32Array([1])], ask)
  expect(j.claims[0]!.memory).toMatchObject({
    action: 'add',
    reason: 'No reconciliation decision returned',
  })
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

it('offers local paraphrases by meaning without shared entities and folds a confirmation', async () => {
  const j = job([
    memory('Harbor invoices each organization.'),
    memory('Billing at Harbor is per organization.'),
  ])
  j.claims.forEach((c, i) => {
    c.memory.entities = [`entity-${i}`]
  })
  const ask = trackAsk(async (_s, _p, prompt, validate) => {
    expect(prompt).toContain(
      'Two claims that say the same thing in different words are the same assertion.',
    )
    const rows = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1))
    expect(rows[0].candidates[0]).toMatchObject({ id: 'c1', local: true })
    return validate(
      JSON.stringify({
        decisions: [{ ref: 'c2', action: 'confirm', target: 'M1', reason: 'Same assertion' }],
      }),
    )
  })
  await reconcile(
    j,
    [],
    new FakeBrainStore(),
    new FakeBrainSearch(),
    [new Float32Array([1, 0]), new Float32Array([0.75, 0.6])],
    ask.ask,
  )
  expect(ask.spy).toHaveBeenCalledOnce()
  expect(j.claims.map((c) => c.ref)).toEqual(['c1'])
})
it('offers stored memories at cosine 0.7', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch()
  store.oldMemories = [old('Harbor invoices each organization.')]
  search.memoryNeighbours = [[{ id: 'old', score: 0.7 }]]
  const ask = trackAsk(async (_s, _p, _prompt, validate) =>
    validate(
      JSON.stringify({
        decisions: [{ ref: 'c1', action: 'confirm', target: 'M1', reason: 'Same' }],
      }),
    ),
  )
  const j = job([memory('Billing is per organization.')])
  await reconcile(j, [], store, search, [new Float32Array([1])], ask.ask)
  expect(ask.spy).toHaveBeenCalledOnce()
  expect(j.claims).toHaveLength(0)
})

it('keeps the first valid reconciliation row and ignores invalid rows and later duplicates', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch()
  store.oldMemories = [old('Earlier Harbor policy.')]
  store.matchesMemory = [['old']]
  const ask = trackAsk(async (_s, _p, _prompt, validate) =>
    validate(
      JSON.stringify({
        decisions: [
          null,
          { ref: 'unknown', action: 'add', target: null, reason: 'Unknown ref' },
          { ref: 'c1', action: 'confirm', target: 'M99', reason: 'Unoffered' },
          { ref: 'c1', action: 'resolve_open', target: 'M1', reason: 'Not open' },
          { ref: 'c1', action: 'add', target: null, reason: 'First valid' },
          { ref: 'c1', action: 'conflict', target: 'M1', reason: 'Later duplicate' },
        ],
      }),
    ),
  )
  const j = job([memory('Harbor policy is different.')])
  await reconcile(j, [], store, search, [new Float32Array([1])], ask.ask)
  expect(ask.spy).toHaveBeenCalledOnce()
  expect(j.claims[0]!.memory).toMatchObject({ action: 'add', reason: 'First valid', target: null })
})

it('never offers excluded reread memories from link/entity or vector candidates', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch()
  store.oldMemories = [
    old('Harbor bills weekly.'),
    { ...old('Ledger bills monthly.'), id: 'other' },
  ]
  store.matchesMemory = [['old', 'other']]
  search.memoryNeighbours = [
    [
      { id: 'old', score: 1 },
      { id: 'other', score: 0.9 },
    ],
  ]
  const ask = trackAsk(async (_s, _p, _prompt, validate) =>
    validate(
      JSON.stringify({
        decisions: [{ ref: 'c1', action: 'add', target: null, reason: 'New read' }],
      }),
    ),
  )
  const j = job([memory('Harbor bills weekly.')])
  const confirmations = await reconcile(j, [], store, search, [new Float32Array([1])], ask.ask, [
    'old',
  ])
  expect(confirmations).toEqual([])
  expect(j.claims).toHaveLength(1)
  expect(ask.spy).toHaveBeenCalledOnce()
  const input = ask.spy.mock.calls[0]![2]
  expect(input).not.toContain('"id":"old"')
  expect(input).toContain('"id":"other"')
})

it('asks the same reconcile prompt for a held claim as before holds existed', async () => {
  const prompts: string[] = []
  const ask = trackAsk(async (_s, _p, prompt, validate) => {
    prompts.push(prompt)
    return validate(
      JSON.stringify({
        decisions: [{ ref: 'c1', action: 'add', target: null, reason: 'Different cadence' }],
      }),
    )
  })
  for (const hold of [undefined, 'temporary'] as const) {
    const store = new FakeBrainStore(),
      search = new FakeBrainSearch(),
      claim = memory('Harbor currently bills weekly.')
    if (hold) claim.hold = hold
    store.oldMemories = [old('Harbor bills monthly.')]
    search.memoryNeighbours = [[{ id: 'old', score: 0.9 }]]
    await reconcile(job([claim]), identities, store, search, [new Float32Array([1])], ask.ask)
  }
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toBe(prompts[0])
  expect(prompts[1]).not.toContain('hold')
})

it.each(['confirm', 'enrich'])('never offers an ended memory for %s', async (action) => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch()
  const m = memory('Harbor bills weekly.')
  store.oldMemories = [{ ...old(action === 'confirm' ? m.summary : 'Harbor bills.'), validTo: 1 }]
  search.memoryNeighbours = [[{ id: 'old', score: 1 }]]
  const j = job([m])
  const ask = trackAsk(async (_s, _p, _prompt, validate) =>
    validate(
      JSON.stringify({ decisions: [{ ref: 'c1', action, target: 'M1', reason: 'Same billing' }] }),
    ),
  )
  expect(await reconcile(j, [], store, search, [new Float32Array([1])], ask.ask)).toEqual([])
  expect(j.claims).toMatchObject([{ memory: { action: 'add', target: null } }])
  expect(ask.spy).not.toHaveBeenCalled()
})

it.each(['supersede', 'conflict', 'resolve_open', 'confirm', 'enrich'])(
  'protects a lasting local claim from a held %s',
  async (action) => {
    for (const hold of ['temporary', 'personal'] as const) {
      const j = job([
        { ...memory('Harbor bills weekly.'), type: 'open' },
        { ...memory('Harbor bills monthly.'), hold },
      ])
      const ask: StageAsk = async (_s, _p, _prompt, validate) =>
        validate(
          JSON.stringify({ decisions: [{ ref: 'c2', action, target: 'M1', reason: 'Billing' }] }),
        )
      await reconcile(
        j,
        [],
        new FakeBrainStore(),
        new FakeBrainSearch(),
        j.claims.map(() => new Float32Array([1])),
        ask,
      )
      expect(j.claims[0]?.ref).toBe('c1')
      expect(j.claims[0]?.memory.hold ?? null).toBeNull()
      expect(j.claims[1]?.memory).toMatchObject({ action: 'add', target: null, hold })
    }
  },
)
