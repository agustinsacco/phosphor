import { expect, it } from 'vitest'
import {
  saveAndListMemories,
  extraction,
  fixture,
  vector,
} from '@phosphor/memory-engine/test-support'
import type { BrainStore, ProposalMemory } from '@phosphor/memory-engine/types'
import { FakeBrainSearch } from '../__fixtures__/fake-store'
import type { StageAsk } from '../stage-types'
import { reconcile } from './reconcile'
import type { FoldedJob } from './fold'

interface Stored {
  summary: string
  observedAt: number
  vector: Float32Array
}
/** One person, Rina Okafor, named by every stored memory. Returns her id and the memory ids by summary. */
function hub(store: BrainStore, memories: Stored[]): { rina: string; ids: Map<string, string> } {
  const base = extraction('')
  saveAndListMemories(store, {
    entities: [base.entities[1]!],
    memories: memories.map((m, i) => ({
      ...base.memories[0]!,
      summary: m.summary,
      entities: ['rina'],
      links: [],
      citations: [{ evidence: i, quote: m.summary }],
    })),
    evidence: memories.map((m, i) => ({
      sessionId: 'harbor-lane',
      entryId: `entry-${i + 1}`,
      role: 'user',
      label: 'You',
      observedAt: m.observedAt,
      text: m.summary,
    })),
    memoryVectors: memories.map((m) => m.vector),
    entityVectors: [vector(0, 0, 1)],
  })
  const rina = store.overview(300).nodes.find((n) => n.label === 'Rina Okafor')!.id
  const ids = new Map(
    store.entityMemories(rina, {}, null).memories.map((m) => [m.summary, m.id] as const),
  )
  return { rina, ids }
}
function claim(summary: string, entities: string[]): FoldedJob {
  const memory: ProposalMemory = {
    ...extraction('').memories[0]!,
    summary,
    entities,
    links: [],
  }
  return { entities: [], claims: [{ ref: 'c1', memory }], parents: [], evidence: [], outcomes: [] }
}
/** Answers add for every claim and keeps the candidate ids each prompt offered. */
function offeredIds(): { ask: StageAsk; offered: string[][] } {
  const offered: string[][] = []
  const ask: StageAsk = async (_s, _p, prompt, validate) => {
    const rows = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as {
      claim: { ref: string }
      candidates: { id: string }[]
    }[]
    offered.push(...rows.map((r) => r.candidates.map((c) => c.id)))
    return validate(
      JSON.stringify({
        decisions: rows.map((r) => ({
          ref: r.claim.ref,
          action: 'add',
          target: null,
          reason: 'New',
        })),
      }),
    )
  }
  return { ask, offered }
}
const unrelated = (count: number, from: number): Stored[] =>
  Array.from({ length: count }, (_, i) => ({
    summary: `Rina Okafor reviews unrelated topic ${i + 1}.`,
    observedAt: from + i,
    vector: vector(0, 1, i + 1),
  }))

it('offers a strong paraphrase about a busy person ahead of her newer unrelated memories', async () => {
  const { store } = fixture()
  const paraphrase = 'Rina Okafor wants review comments posted only after she approves them.'
  const { rina, ids } = hub(store, [
    { summary: paraphrase, observedAt: 1, vector: vector(1, 0.1) },
    ...unrelated(6, 10),
  ])
  const search = new FakeBrainSearch()
  search.memoryNeighbours = [[{ id: ids.get(paraphrase)!, score: 0.95 }]]
  const { ask, offered } = offeredIds()
  await reconcile(
    claim('Rina Okafor wants review comments posted only once she says so.', [rina]),
    [],
    store,
    search,
    [vector(1)],
    ask,
  )
  expect(offered[0]).toContain(ids.get(paraphrase))
  expect(offered[0]![0]).toBe(ids.get(paraphrase))
})

it('ranks memories that only share a person by similarity to the claim, not by recency', async () => {
  const { store } = fixture()
  const closest = 'Rina Okafor approves the Harbor release notes.'
  const { rina, ids } = hub(store, [
    // Cosine 0.45: below the semantic threshold, so it is found only by naming Rina.
    { summary: closest, observedAt: 1, vector: vector(1, 2) },
    ...unrelated(6, 10),
  ])
  const { ask, offered } = offeredIds()
  await reconcile(
    claim('Rina Okafor signs off the Harbor changelog.', [rina]),
    [],
    store,
    new FakeBrainSearch(),
    [vector(1)],
    ask,
  )
  expect(offered[0]).toHaveLength(5)
  expect(offered[0]![0]).toBe(ids.get(closest))
})

/** Rina's weekly preference, then a later read that replaced it with a daily one. */
function replacedPreference(store: BrainStore): { rina: string; weekly: string } {
  const weeklySummary = 'Rina Okafor wants weekly status updates.'
  const { rina, ids } = hub(store, [
    { summary: weeklySummary, observedAt: 1, vector: vector(1, 0.2) },
  ])
  const weekly = ids.get(weeklySummary)!
  const base = extraction('')
  saveAndListMemories(store, {
    jobId: 'leaf-2',
    entities: [],
    entityVectors: [],
    memories: [
      {
        ...base.memories[0]!,
        summary: 'Rina Okafor wants daily status updates.',
        entities: [rina],
        links: [],
        citations: [{ evidence: 0, quote: 'Rina owns Harbor.' }],
        action: 'supersede',
        target: weekly,
      },
    ],
    memoryVectors: [vector(0, 1)],
  })
  return { rina, weekly }
}
interface OfferedCandidate {
  id: string
  handle: string
  replaced?: boolean
}
/** Says a claim repeats the replaced memory when it is offered, otherwise adds it. */
function repeatsWhenOffered(id: string): { ask: StageAsk; offered: OfferedCandidate[][] } {
  const offered: OfferedCandidate[][] = []
  const ask: StageAsk = async (_s, _p, prompt, validate) => {
    const rows = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as {
      claim: { ref: string }
      candidates: OfferedCandidate[]
    }[]
    offered.push(...rows.map((r) => r.candidates))
    return validate(
      JSON.stringify({
        decisions: rows.map((r) => {
          const replaced = r.candidates.find((c) => c.id === id)
          return replaced
            ? {
                ref: r.claim.ref,
                action: 'repeats_replaced',
                target: replaced.handle,
                reason: 'Old',
              }
            : { ref: r.claim.ref, action: 'add', target: null, reason: 'New' }
        }),
      }),
    )
  }
  return { ask, offered }
}

it('offers a close replaced memory as replaced earlier and drops a claim that repeats it', async () => {
  const { store } = fixture()
  const { rina, weekly } = replacedPreference(store)
  expect(store.memory(weekly).memory.state).toBe('superseded')
  const { ask, offered } = repeatsWhenOffered(weekly)
  const job = claim('Rina Okafor asks for weekly status updates.', [rina])
  await reconcile(job, [], store, new FakeBrainSearch(), [vector(1, 0.25)], ask)
  expect(offered[0]).toContainEqual(expect.objectContaining({ id: weekly, replaced: true }))
  expect(job.claims).toEqual([])
  expect(job.outcomes).toContainEqual(
    expect.objectContaining({
      candidate: 'c1',
      status: 'dropped',
      reason: 'Repeats a memory that was replaced earlier',
    }),
  )
})

it('drops a claim equal to a replaced memory without asking the model', async () => {
  const { store } = fixture()
  const { rina, weekly } = replacedPreference(store)
  const { ask, offered } = repeatsWhenOffered(weekly)
  const job = claim('Rina Okafor wants weekly status updates.', [rina])
  await reconcile(job, [], store, new FakeBrainSearch(), [vector(1, 0.2)], ask)
  expect(offered).toEqual([])
  expect(job.claims).toEqual([])
  expect(job.outcomes).toContainEqual(
    expect.objectContaining({ candidate: 'c1', status: 'dropped' }),
  )
})

it('does not offer a replaced memory below cosine 0.85', async () => {
  const { store } = fixture()
  const { rina, weekly } = replacedPreference(store)
  const { ask, offered } = repeatsWhenOffered(weekly)
  // Cosine 0.62 with the weekly preference.
  const job = claim('Rina Okafor reads status updates on Fridays.', [rina])
  await reconcile(job, [], store, new FakeBrainSearch(), [vector(1, 1.5)], ask)
  expect(offered.flat().map((c) => c.id)).not.toContain(weekly)
  expect(job.claims).toHaveLength(1)
})

it('refuses any other action on a replaced memory, and repeats_replaced on a current one', async () => {
  const { store } = fixture()
  const { rina, weekly } = replacedPreference(store)
  const daily = store
    .entityMemories(rina, {}, null)
    .memories.find((m) => m.summary.includes('daily'))!.id
  const answers: string[][] = []
  const ask: StageAsk = async (_s, _p, prompt, validate) => {
    const rows = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as {
      claim: { ref: string }
      candidates: OfferedCandidate[]
    }[]
    const handle = (id: string) => rows[0]!.candidates.find((c) => c.id === id)!.handle
    answers.push(rows[0]!.candidates.map((c) => c.id))
    return validate(
      JSON.stringify({
        decisions: [
          { ref: 'c1', action: 'supersede', target: handle(weekly), reason: 'Wrong' },
          { ref: 'c1', action: 'repeats_replaced', target: handle(daily), reason: 'Wrong' },
        ],
      }),
    )
  }
  const search = new FakeBrainSearch()
  search.memoryNeighbours = [[{ id: daily, score: 0.9 }]]
  const job = claim('Rina Okafor asks for weekly status updates.', [rina])
  await reconcile(job, [], store, search, [vector(1, 0.25)], ask)
  expect(answers).toHaveLength(2)
  expect(job.claims[0]!.memory).toMatchObject({
    action: 'add',
    reason: 'No reconciliation decision returned',
  })
})

function entityIdByLabel(store: ReturnType<typeof fixture>['store']) {
  const nodes = store.overview(300).nodes
  return (label: string) => nodes.find((n) => n.label === label)!.id
}

it('regression: a shared link counts only with the same predicate, so uses links cannot crowd out a close depends_on paraphrase', async () => {
  const { store } = fixture()
  const base = extraction('')
  const harbor = base.entities[0]!
  const ledger = { ...harbor, ref: 'ledger', label: 'Ledger', aliases: [] }
  const paraphrase = 'Harbor cannot start without Ledger.'
  const uses = ['exports', 'refunds', 'invoices', 'audits', 'retries'].map(
    (topic) => `Harbor uses Ledger for ${topic}.`,
  )
  const summaries = [paraphrase, ...uses]
  saveAndListMemories(store, {
    entities: [harbor, ledger],
    entityVectors: [vector(0, 0, 1), vector(0, 0, 1)],
    memories: summaries.map((summary, i) => ({
      ...base.memories[0]!,
      summary,
      entities: ['harbor', 'ledger'],
      links: i
        ? [
            {
              subject: 'harbor',
              predicate: 'uses' as const,
              object: 'ledger',
              label: '',
              citation: { evidence: i, quote: summary },
            },
          ]
        : [],
      citations: [{ evidence: i, quote: summary }],
    })),
    evidence: summaries.map((summary, i) => ({
      sessionId: 'harbor-lane',
      entryId: `entry-${i + 1}`,
      role: 'user' as const,
      label: 'You',
      observedAt: 10 + i,
      text: summary,
    })),
    // The paraphrase is close to the claim; the uses memories are not.
    memoryVectors: summaries.map((_, i) => (i ? vector(0, 1, i) : vector(1, 0.1))),
  })
  const id = entityIdByLabel(store)
  const ids = new Map(
    store.entityMemories(id('Harbor'), {}, null).memories.map((m) => [m.summary, m.id] as const),
  )
  const search = new FakeBrainSearch()
  search.memoryNeighbours = [[{ id: ids.get(paraphrase)!, score: 0.95 }]]
  const job = claim('Harbor needs Ledger running before it starts.', [id('Harbor'), id('Ledger')])
  job.claims[0]!.memory.links = [
    {
      subject: id('Harbor'),
      predicate: 'depends_on',
      object: id('Ledger'),
      label: '',
      citation: { evidence: 0, quote: 'Harbor needs Ledger running before it starts.' },
    },
  ]
  const { ask, offered } = offeredIds()
  await reconcile(job, [], store, search, [vector(1)], ask)
  expect(offered[0]).toHaveLength(5)
  expect(offered[0]).toContain(ids.get(paraphrase))
  expect(offered[0]![0]).toBe(ids.get(paraphrase))
})

it('regression: five earlier uses claims of the same read cannot push out a close depends_on paraphrase', async () => {
  const { store } = fixture()
  const base = extraction('')
  const harbor = base.entities[0]!
  const ledger = { ...harbor, ref: 'ledger', label: 'Ledger', aliases: [] }
  const paraphrase = 'Harbor cannot start without Ledger.'
  saveAndListMemories(store, {
    entities: [harbor, ledger],
    entityVectors: [vector(0, 0, 1), vector(0, 0, 1)],
    memories: [
      { ...base.memories[0]!, summary: paraphrase, entities: ['harbor', 'ledger'], links: [] },
    ],
    memoryVectors: [vector(1, 0.1)],
  })
  const id = entityIdByLabel(store)
  const stored = store.entityMemories(id('Harbor'), {}, null).memories[0]!.id
  const link = (predicate: 'uses' | 'depends_on', quote: string) => ({
    subject: id('Harbor'),
    predicate,
    object: id('Ledger'),
    label: '',
    citation: { evidence: 0, quote },
  })
  const summaries = [
    ...['exports', 'refunds', 'invoices', 'audits', 'retries'].map(
      (topic) => `Harbor uses Ledger for ${topic}.`,
    ),
    'Harbor needs Ledger running before it starts.',
  ]
  const job: FoldedJob = {
    entities: [],
    claims: summaries.map((summary, i) => ({
      ref: `c${i + 1}`,
      memory: {
        ...base.memories[0]!,
        summary,
        entities: [id('Harbor'), id('Ledger')],
        links: [link(i < 5 ? 'uses' : 'depends_on', summary)],
      },
    })),
    parents: [],
    evidence: [],
    outcomes: [],
  }
  const search = new FakeBrainSearch()
  search.memoryNeighbours = summaries.map((_, i) => (i < 5 ? [] : [{ id: stored, score: 0.95 }]))
  const offered = new Map<string, string[]>()
  const ask: StageAsk = async (_s, _p, prompt, validate) => {
    const rows = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as {
      claim: { ref: string }
      candidates: { id: string }[]
    }[]
    for (const row of rows)
      offered.set(
        row.claim.ref,
        row.candidates.map((c) => c.id),
      )
    return validate(
      JSON.stringify({
        decisions: rows.map((r) => ({
          ref: r.claim.ref,
          action: 'add',
          target: null,
          reason: 'New',
        })),
      }),
    )
  }
  await reconcile(
    job,
    [],
    store,
    search,
    summaries.map((_, i) => (i < 5 ? vector(0, 1, i + 1) : vector(1))),
    ask,
  )
  expect(offered.get('c6')).toHaveLength(5)
  expect(offered.get('c6')).toContain(stored)
  expect(offered.get('c6')![0]).toBe(stored)
})
