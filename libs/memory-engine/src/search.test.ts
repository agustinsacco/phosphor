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
    ).toEqual({ status: 'no_match', hits: [], entities: [], degradation: [] })
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
  it('defaults to six hits and caps search at twenty', () => {
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
    expect(store.search(input).hits).toHaveLength(6)
    expect(store.search({ ...input, limit: 200 }).hits).toHaveLength(20)
  })
})

describe('Brain related', () => {
  it('resolves id, folded label and alias, returning neighbours with exact reasons', () => {
    const { store } = fixture()
    approve(store)
    const harbor = store.knowledge().entities.find((item) => item.label === 'Harbor')!
    for (const query of [harbor.id, ' ＨＡＲＢＯＲ ', 'Harbor billing service']) {
      const result = store.related(query, 12, null)
      expect(result.hits).toHaveLength(2)
      expect(result.entities.map((item) => item.label).sort()).toEqual([
        'Harbor',
        'Rina Okafor',
        'Tom Lee',
      ])
      expect(result.hits.every((hit) => hit.reasons.join() === 'exact')).toBe(true)
    }
  })
  it('falls back to names with shared words and refuses unrelated words', () => {
    const { store } = fixture()
    approve(store)
    expect(store.related('Okafor biography', 12, null).hits[0]?.memory.summary).toContain(
      'Rina Okafor',
    )
    expect(store.related('unrelatedword', 12, null)).toEqual({
      status: 'no_match',
      hits: [],
      entities: [],
      degradation: [],
    })
  })
  it('ranks scope first, then newest, and respects the requested limit', () => {
    const { store } = fixture()
    seed(store, [
      { label: 'Harbor', summary: 'Older local note.', vector: vector(1) },
      { label: 'Harbor', summary: 'Newer other note.', vector: vector(0, 1), scope: '/other' },
    ])
    expect(
      store.related('Harbor', 12, '/projects/harbor').hits.map((hit) => hit.memory.summary),
    ).toEqual(['Older local note.', 'Newer other note.'])
    expect(store.related('Harbor', 1, null).hits[0]?.memory.summary).toBe('Newer other note.')
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
        observedAt: 0,
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
        observedAt: 0,
        type: 'open',
      },
      { label: 'F', summary: 'Ama owns refunds.', vector: direction(0.9, 2), observedAt: 0 },
    ])
    const hits = store.search({ query: 'zzz', vector: vector(1), scope: null, limit: 6 }).hits
    expect(hits.map((hit) => hit.memory.type)).toEqual(['fact', 'open'])
  })
})
