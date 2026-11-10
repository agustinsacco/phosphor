import { describe, expect, it } from 'vitest'
import { approve, extraction, fixture, vector } from './test-support'
import type { BrainMemoryType } from '@phosphor/shared/brain'
import type { BrainStore, Extraction } from './types'

function seed(
  store: BrainStore,
  entries: {
    label: string
    summary: string
    vector: Float32Array
    scope?: string
    observedAt?: number
    type?: BrainMemoryType
  }[],
): void {
  entries.forEach((entry, index) => {
    const base = extraction('unused')
    const data: Partial<Extraction> = {
      jobId: `leaf-${index}`,
      origin: { sessionId: `lane-${index}`, title: 'Harbor knowledge' },
      scope: entry.scope ?? '/projects/harbor',
      entities: [{ key: 'subject', label: entry.label, kind: 'concept', aliases: [] }],
      memories: [
        {
          ...base.memories[0]!,
          subject: 'subject',
          object: null,
          predicate: 'about',
          summary: entry.summary,
          type: entry.type ?? base.memories[0]!.type,
        },
      ],
      evidence: base.evidence.map((item) => ({
        ...item,
        observedAt: entry.observedAt ?? item.observedAt,
      })),
      vectors: [entry.vector],
    }
    approve(store, data)
  })
}
function direction(cosine: number, axis: number): Float32Array {
  const result = vector(cosine)
  result[axis] = Math.sqrt(1 - cosine ** 2)
  return result
}
describe('Brain meaning-first hybrid search', () => {
  it('recalls a paraphrase with no shared words through semantic meaning', () => {
    const { store } = fixture()
    seed(store, [
      { label: 'Harbor', summary: 'Harbor retries failed invoice requests.', vector: vector(1) },
    ])
    const result = store.search({
      query: 'network resilience',
      vector: vector(1),
      scope: null,
      limit: 6,
    })
    expect(result.status).toBe('ok')
    expect(result.hits[0]?.reasons).toEqual(['semantic'])
    expect(result.hits[0]?.score).toBeCloseTo(2 / 61)
    expect(result.hits[0]).not.toHaveProperty('quotes')
    expect(JSON.stringify(result)).not.toContain('Rina owns Harbor.')
  })
  it('fuses semantic, lexical and exact rankings with weights 2:1:1', () => {
    const { store } = fixture()
    seed(store, [
      { label: 'Harbor', summary: 'Harbor retries failed requests.', vector: direction(0.8, 1) },
      { label: 'Quasar', summary: 'Invoices settle each morning.', vector: direction(0.5, 2) },
      {
        label: 'Archive',
        summary: 'The quasar protocol preserves receipts.',
        vector: direction(0.2, 3),
      },
    ])
    const result = store.search({ query: 'Quasar', vector: vector(1), scope: null, limit: 6 })
    expect(result.hits.map((hit) => hit.memory.subjectId)).toHaveLength(3)
    const bySummary = new Map(result.hits.map((hit) => [hit.memory.summary, hit]))
    const fused = bySummary.get('Invoices settle each morning.')!
    expect(result.hits[0]).toBe(fused)
    expect(fused.reasons).toEqual(['semantic', 'lexical', 'exact'])
    const lexicalRank = store
      .search({ query: 'Quasar', vector: null, scope: null, limit: 6 })
      .hits.findIndex((hit) => hit.memory.id === fused.memory.id)
    // Both lexical rows have one matching word and the same indexed token count.
    expect(fused.score).toBeCloseTo(2 / 62 + 1 / 61 + 1 / 61)
    expect(lexicalRank).toBe(0)
    expect(bySummary.get('Harbor retries failed requests.')?.score).toBeCloseTo(2 / 61)
    expect(bySummary.get('The quasar protocol preserves receipts.')?.reasons).toEqual(['lexical'])
  })
  it('applies the 0.35 semantic floor and returns no_match when no evidence passes', () => {
    const { store } = fixture()
    seed(store, [
      { label: 'Harbor', summary: 'Daily settlement.', vector: direction(0.35001, 1) },
      { label: 'Archive', summary: 'Monthly retention.', vector: direction(0.34999, 2) },
    ])
    const result = store.search({ query: 'unseenword', vector: vector(1), scope: null, limit: 6 })
    expect(result.hits.map((hit) => hit.memory.summary)).toEqual(['Daily settlement.'])
    expect(
      store.search({ query: 'unseenword', vector: vector(-1), scope: null, limit: 6 }),
    ).toEqual({
      status: 'no_match',
      hits: [],
      entities: [],
      focus: [],
      links: [],
      more: 0,
      degradation: [],
    })
  })
  it('boosts the asking project by 1.25 without excluding other projects', () => {
    const { store } = fixture()
    seed(store, [
      {
        label: 'Other',
        summary: 'Other project note.',
        vector: direction(0.8, 1),
        scope: '/projects/other',
      },
      { label: 'Harbor', summary: 'Harbor project note.', vector: direction(0.7, 2) },
    ])
    const neutral = store.search({ query: '', vector: vector(1), scope: null, limit: 6 })
    const local = store.search({
      query: '',
      vector: vector(1),
      scope: '/projects/harbor',
      limit: 6,
    })
    expect(neutral.hits[0]?.memory.summary).toBe('Other project note.')
    expect(local.hits[0]?.memory.summary).toBe('Harbor project note.')
    expect(local.hits[0]?.score).toBeCloseTo(neutral.hits[1]!.score * 1.25)
    expect(local.hits).toHaveLength(2)
  })
  it('degrades to lexical/exact for null vectors and strips stopwords and punctuation safely', () => {
    const { store } = fixture()
    approve(store)
    const result = store.search({
      query: 'Who owns "Rina Okafor"? OR (never:*)',
      vector: null,
      scope: null,
      limit: 6,
    })
    expect(result.degradation).toEqual(['semantic search unavailable'])
    expect(result.hits[0]?.reasons).toEqual(['lexical', 'exact'])
    expect(result.hits[0]?.memory.summary).toContain('Rina Okafor')
    const empty = store.search({
      query: 'what do we know about',
      vector: null,
      scope: null,
      limit: 6,
    })
    expect(empty.status).toBe('no_match')
    expect(empty.degradation).toEqual(['semantic search unavailable'])
  })
  it('uses whole phrases for folded entity aliases, never substrings', () => {
    const { store } = fixture()
    approve(store)
    const matching = store.search({
      query: '  ＲＩＮＡ   OKAFOR ',
      vector: null,
      scope: null,
      limit: 6,
    })
    expect(matching.hits[0]?.reasons).toContain('exact')
    const partial = store.search({ query: 'Marina', vector: null, scope: null, limit: 6 })
    expect(partial.status).toBe('no_match')
    const alias = store.search({
      query: 'Tell me about Rina.',
      vector: null,
      scope: null,
      limit: 6,
    })
    expect(alias.hits[0]?.reasons).toContain('exact')
  })
  it('defaults to eight hits and caps search at twenty', () => {
    const { store } = fixture()
    seed(
      store,
      Array.from({ length: 25 }, (_, index) => {
        const vec = new Float32Array(768)
        vec[index] = 1
        return { label: `Thing ${index}`, summary: `Harbor note ${index}.`, vector: vec }
      }),
    )
    const input = {
      query: 'Harbor',
      vector: null,
      scope: null,
      limit: undefined as unknown as number,
    }
    expect(store.search(input).hits).toHaveLength(8)
    expect(store.search({ ...input, limit: 200 }).hits).toHaveLength(20)
  })
})

/** Harbor billing and Harbor ledger share a word; Harborview only looks like them. */
function harborGraph(store: BrainStore): Map<string, string> {
  const base = extraction('graph')
  const memory = (
    subject: string,
    object: string | null,
    summary: string,
    type: BrainMemoryType,
  ): Extraction['memories'][number] => ({
    ...base.memories[0]!,
    subject,
    object,
    predicate: object ? 'owns' : 'about',
    summary,
    type,
  })
  const memories = [
    memory('rina', 'billing', 'Rina Okafor owns Harbor billing.', 'fact'),
    memory('billing', null, 'Invoices retry three times before paging.', 'risk'),
    memory('ledger', null, 'The ledger closes every night at two.', 'fact'),
    memory('view', null, 'Harborview is a separate product.', 'fact'),
    memory('rina', null, 'Rina is away until December.', 'open'),
    memory('tom', null, 'Tom Lee prefers small reviews.', 'preference'),
  ]
  approve(store, {
    jobId: 'graph',
    entities: [
      { key: 'billing', label: 'Harbor billing', kind: 'project', aliases: ['SKT-100'] },
      { key: 'ledger', label: 'Harbor ledger', kind: 'component', aliases: [] },
      { key: 'view', label: 'Harborview', kind: 'concept', aliases: [] },
      { key: 'rina', label: 'Rina Okafor', kind: 'person', aliases: [] },
      { key: 'tom', label: 'Tom Lee', kind: 'person', aliases: [] },
    ],
    memories,
    vectors: memories.map((_, index) => direction(0, index + 1)),
  })
  return new Map(store.knowledge().entities.map((item) => [item.label, item.id]))
}
const lexical = (query: string, limit = 8) => ({ query, vector: null, scope: null, limit })

describe('Brain search briefing', () => {
  it('names every entity the query names or sits inside, and finds what they hold', () => {
    const { store } = fixture()
    const ids = harborGraph(store)
    const result = store.search(lexical('Harbor'))
    expect(result.focus).toEqual([ids.get('Harbor billing'), ids.get('Harbor ledger')])
    const summaries = result.hits.map((hit) => hit.memory.summary)
    expect(summaries).toEqual(
      expect.arrayContaining([
        'Rina Okafor owns Harbor billing.',
        'Invoices retry three times before paging.',
        'The ledger closes every night at two.',
      ]),
    )
    expect(summaries).not.toContain('Harborview is a separate product.')
    expect(summaries).not.toContain('Tom Lee prefers small reviews.')
    expect(store.search(lexical('What is SKT-100 waiting on?')).focus).toEqual([
      ids.get('Harbor billing'),
    ])
    expect(store.search(lexical('the')).focus).toEqual([])
  })
  it('keeps punctuation that is part of a name when the query sits inside one', () => {
    const { store } = fixture()
    seed(
      store,
      ['C++', 'C#', 'C framework'].map((label, index) => ({
        label,
        summary: `Note ${index}.`,
        vector: direction(0, index + 1),
      })),
    )
    const labels = (query: string): string[] => {
      const { entities, focus } = store.search(lexical(query))
      return entities.filter((item) => focus.includes(item.id)).map((item) => item.label)
    }
    expect(labels('C++')).toEqual(['C++'])
    expect(labels('"C#"?')).toEqual(['C#'])
  })
  it('follows links one hop out and ranks what a neighbour holds below the named entities', () => {
    const { store } = fixture()
    const ids = harborGraph(store)
    const result = store.search(lexical('Harbor'))
    expect(result.links).toEqual([
      { subjectId: ids.get('Rina Okafor'), predicate: 'owns', objectId: ids.get('Harbor billing') },
    ])
    expect(result.entities.map((item) => item.label).sort()).toEqual([
      'Harbor billing',
      'Harbor ledger',
      'Rina Okafor',
    ])
    expect(result.hits.at(-1)).toMatchObject({
      memory: { summary: 'Rina is away until December.' },
      reasons: ['linked'],
    })
  })
  it('counts strong matches the limit left out, never neighbours or loose meaning', () => {
    const { store } = fixture()
    harborGraph(store)
    expect(store.search(lexical('Harbor', 2))).toMatchObject({ more: 1 })
    expect(store.search(lexical('Harbor', 2)).hits).toHaveLength(2)
    expect(store.search(lexical('Harbor'))).toMatchObject({ more: 0 })
    const many = fixture().store
    seed(
      many,
      Array.from({ length: 60 }, (_, index) => ({
        label: `Thing ${index}`,
        summary: `Invoice retry note ${index}.`,
        vector: direction(0, index + 1),
      })),
    )
    expect(many.search(lexical('retry'))).toMatchObject({ more: 52 })
    expect(store.search(lexical('Marina'))).toEqual({
      status: 'no_match',
      hits: [],
      entities: [],
      focus: [],
      links: [],
      more: 0,
      degradation: ['semantic search unavailable'],
    })
  })
})

const DAY = 86_400_000
describe('Brain search by age', () => {
  it('ranks what a lane said recently above a slightly closer match it said long ago', () => {
    const { store } = fixture(400 * DAY)
    seed(store, [
      {
        label: 'Old',
        summary: 'Harbor exports run weekly.',
        vector: direction(0.92, 1),
        observedAt: DAY,
      },
      {
        label: 'New',
        summary: 'Harbor exports run nightly.',
        vector: direction(0.9, 2),
        observedAt: 399 * DAY,
      },
    ])
    const hits = store.search({ query: 'zzz', vector: vector(1), scope: null, limit: 6 }).hits
    expect(hits.map((hit) => hit.memory.summary)).toEqual([
      'Harbor exports run nightly.',
      'Harbor exports run weekly.',
    ])
  })
  it('lets an old open question sink faster than a fact of the same age, but keeps both', () => {
    const { store } = fixture(120 * DAY)
    seed(store, [
      {
        label: 'Q',
        summary: 'Who owns refunds?',
        vector: direction(0.92, 1),
        observedAt: DAY,
        type: 'open',
      },
      { label: 'F', summary: 'Ama owns refunds.', vector: direction(0.9, 2), observedAt: 0 },
    ])
    const hits = store.search({ query: 'zzz', vector: vector(1), scope: null, limit: 6 }).hits
    expect(hits.map((hit) => hit.memory.type)).toEqual(['fact', 'open'])
  })
})
