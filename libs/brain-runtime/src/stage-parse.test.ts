import { expect, it } from 'vitest'
import { parseStageExtraction, verifiedQuote } from './stage-parse'
import { makeWindow } from './windows'
import { RAW_EXTRACTION } from './__fixtures__/lane'
const segment = (text: string) => ({
  entryId: 'u',
  role: 'user' as const,
  label: 'You',
  observedAt: 0,
  text,
})
const window = makeWindow([segment('Rina Okafor owns Harbor billing.')])
it('accepts fenced JSON and corrects the quote segment handle', () => {
  const value = structuredClone(RAW_EXTRACTION)
  value.claims[0]!.quotes[0]!.segment = 's9'
  expect(
    parseStageExtraction('```json\n' + JSON.stringify(value) + '\n```', window).claims[0]!
      .quotes[0]!.segment,
  ).toBe('s1')
})
it('never verifies a quote across, or containing, an elision marker', () => {
  const w = makeWindow([segment('head[… 200 chars omitted …]tail')])
  expect(() => verifiedQuote({ segment: 's1', quote: 'headtail' }, w)).toThrow('Quote not found')
  expect(() => verifiedQuote({ segment: 's1', quote: w.segments[0]!.text }, w)).toThrow('elision')
  expect(verifiedQuote({ segment: 's1', quote: 'tail' }, w)).toEqual({
    segment: 's1',
    quote: 'tail',
  })
})

it.each([
  { label: 'x'.repeat(81) },
  { predicate: 'unknown' },
  { since: '2026-02-30' },
  { until: 'not a date' },
])('rejects invalid sentence link metadata: %j', (bad) => {
  const quote = 'Rina Okafor owns Harbor billing.'
  const window = makeWindow([
    { entryId: 'u', role: 'user', label: 'You', observedAt: 1, text: quote },
  ])
  const raw = structuredClone(RAW_EXTRACTION)
  Object.assign(raw.claims[0]!.links[0]!, bad)
  const parsed = parseStageExtraction(JSON.stringify(raw), window)
  expect(parsed.claims[0]!.links).toEqual([])
  expect(parsed.outcomes).toContainEqual(expect.objectContaining({ status: 'dropped' }))
})

it('keeps the wording, dates and importance of a dated person-to-person relationship', () => {
  const raw = structuredClone(RAW_EXTRACTION)
  raw.entities[1] = { ...raw.entities[1]!, kind: 'person', label: 'Tom Lee' }
  const sentence = 'Rina Okafor took over Ledger billing from Tom Lee.'
  Object.assign(raw.claims[0]!, {
    importance: 2,
    text: sentence,
    quotes: [{ segment: 's1', quote: sentence }],
  })
  Object.assign(raw.claims[0]!.links[0]!, {
    predicate: 'took_over_from',
    label: 'took over Ledger billing from',
    quote: sentence,
    since: '2026-09-01',
    until: '2026-10-01',
  })
  const parsed = parseStageExtraction(JSON.stringify(raw), makeWindow([segment(sentence)]))
  expect(parsed.claims[0]).toMatchObject({
    importance: 2,
    links: [
      {
        predicate: 'took_over_from',
        label: 'took over Ledger billing from',
        validFrom: Date.UTC(2026, 8, 1),
        validTo: Date.UTC(2026, 9, 1),
      },
    ],
  })
})
