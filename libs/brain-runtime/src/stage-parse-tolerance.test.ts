import { expect, it } from 'vitest'
import { parseStageExtraction, verifiedQuote } from './stage-parse'
import { makeWindow } from './windows'
import { RAW_EXTRACTION } from './__fixtures__/lane'
const window = makeWindow([
  {
    entryId: 'u',
    role: 'user',
    label: 'You',
    observedAt: 0,
    text: 'Rina Okafor owns Harbor billing.',
  },
])
const parse = (value: unknown) => {
  const run = () => parseStageExtraction(JSON.stringify(value), window)
  expect(run).not.toThrow()
  return run()
}
it.each([
  ['bad ref', { ref: 'bad' }],
  ['unknown kind', { kind: 'ticket' }],
  ['sensitive label', { label: 'rina@example.com' }],
  ['description', { description: 'x'.repeat(161) }],
])('drops an invalid entity (%s) without failing unrelated claims', (_name, invalid) => {
  const v = structuredClone(RAW_EXTRACTION)
  v.entities.push({ ...v.entities[0]!, ref: 'n3', ...invalid } as (typeof v.entities)[number])
  const result = parse(v)
  expect(result.entities).toHaveLength(2)
  expect(result.claims).toHaveLength(1)
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      status: 'dropped',
      candidate: 'ref' in invalid && invalid.ref === 'bad' ? 'entity[3]' : 'n3',
    }),
  )
})
it.each([
  { mentions: ['missing'] },
  { type: 'unknown' },
  { validFrom: '2026-02-30' },
  { quotes: [{ segment: 's1', quote: 'not here' }] },
  { ref: 'bad' },
])('drops only the invalid claim %j', (invalid) => {
  const v = structuredClone(RAW_EXTRACTION)
  v.claims.push({ ...v.claims[0]!, ref: 'c2', ...invalid } as (typeof v.claims)[number])
  const result = parse(v)
  expect(result.claims.map((c) => c.ref)).toEqual(['c1'])
  expect(result.outcomes?.[0]).toMatchObject({
    status: 'dropped',
    candidate: 'ref' in invalid && invalid.ref === 'bad' ? 'claim[2]' : 'c2',
  })
})
it.each([
  { subject: 'missing' },
  { object: 'n1' },
  { predicate: 'related_to' },
  { subject: 'n2', object: 'n1' },
  { quote: 'not here' },
])('drops only the invalid link %j and retains endpoint mentions', (invalid) => {
  const v = structuredClone(RAW_EXTRACTION)
  v.claims[0]!.mentions = []
  Object.assign(v.claims[0]!.links[0]!, invalid)
  const result = parse(v)
  expect(result.claims).toHaveLength(1)
  expect(result.claims[0]!.links).toEqual([])
  if (!('subject' in invalid) && !('object' in invalid))
    expect(result.claims[0]!.mentions).toEqual(['n1', 'n2'])
  expect(result.outcomes?.[0]).toMatchObject({ status: 'dropped', candidate: 'c1' })
})
it('keeps the first ref and defaults missing or invalid parent assessments', () => {
  const v = structuredClone(RAW_EXTRACTION)
  v.entities.push({ ...v.entities[0]!, label: 'Other' })
  v.claims.push({ ...v.claims[0]!, text: 'Other' })
  v.parents = [{ entity: 'n2', status: 'stated', claim: 'missing' }]
  const result = parse(v)
  expect(result.entities).toHaveLength(2)
  expect(result.claims).toHaveLength(1)
  expect(result.parents).toEqual([{ entity: 'n2', status: 'not_stated', claim: null }])
  expect(parse({ ...v, parents: undefined }).parents).toEqual(result.parents)
})
it('keeps at most 25 claims and reports the rest, without splitting', () => {
  const v = structuredClone(RAW_EXTRACTION)
  v.claims = Array.from({ length: 27 }, (_, i) => ({ ...v.claims[0]!, ref: `c${i + 1}` }))
  const result = parse(v)
  expect(result.claims).toHaveLength(25)
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({
      candidate: 'c26',
      status: 'dropped',
      reason: 'Over the 25-claim limit for one part',
    }),
  )
})
it('keeps valid quotes among invalid ones and stores flexible matches verbatim', () => {
  const source = 'Rina says “keep\n  billing stable”.'
  const w = makeWindow([{ ...window.segments[0]!, text: source }])
  expect(() =>
    verifiedQuote({ segment: 's9', quote: 'Rina says "keep billing stable".' }, w),
  ).not.toThrow()
  const q = verifiedQuote({ segment: 's9', quote: 'Rina says "keep billing stable".' }, w)
  expect(q).toEqual({ segment: 's1', quote: source })
  expect(w.segments[0]!.text.includes(q.quote)).toBe(true)
  const v = structuredClone(RAW_EXTRACTION)
  v.claims[0]!.quotes.unshift({ segment: 's1', quote: 'bad' })
  expect(parse(v).claims[0]!.quotes).toHaveLength(1)
})
it('still rejects an unusable envelope', () => {
  expect(() => parseStageExtraction('no answer', window)).toThrow()
  expect(() => parseStageExtraction(JSON.stringify({ entities: {}, claims: [] }), window)).toThrow()
  expect(() =>
    parseStageExtraction(JSON.stringify({ entities: [], claims: null }), window),
  ).toThrow()
})

it('drops a malformed link list rather than its otherwise supported claim', () => {
  const v = structuredClone(RAW_EXTRACTION)
  const result = parse({ ...v, claims: [{ ...v.claims[0], links: null }] })
  expect(result.claims).toHaveLength(1)
  expect(result.claims[0]!.links).toEqual([])
  expect(result.outcomes).toContainEqual(
    expect.objectContaining({ candidate: 'c1', status: 'dropped' }),
  )
})
it('validates offered registry endpoint kinds as well as new entity kinds', () => {
  const v = structuredClone(RAW_EXTRACTION)
  v.claims[0]!.links[0]!.object = 'r1'
  const registry = [{ ...v.entities[1]!, ref: 'r1', kind: 'person' as const }]
  const result = parseStageExtraction(JSON.stringify(v), window, registry)
  expect(result.claims[0]!.links).toEqual([])
  expect(result.claims[0]!.mentions).toContain('r1')
})
it('prefers exact source text before flexible matching and never flexes across an elision', () => {
  const w = makeWindow([
    { ...window.segments[0]!, text: 'Rina says “keep   billing stable”.' },
    { ...window.segments[0]!, text: 'Rina says "keep billing stable".' },
  ])
  const q = { segment: 's1', quote: 'Rina says "keep billing stable".' }
  expect(verifiedQuote(q, w).segment).toBe('s2')
  const elided = makeWindow([
    { ...window.segments[0]!, text: 'keep[… 20 chars omitted …] billing' },
  ])
  expect(() => verifiedQuote({ segment: 's1', quote: 'keep billing' }, elided)).toThrow(
    'Quote not found',
  )
})
