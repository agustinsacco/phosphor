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
const parse = (v: unknown) => parseStageExtraction(JSON.stringify(v), window)
it('accepts fenced JSON and corrects the quote segment handle', () => {
  const value = structuredClone(RAW_EXTRACTION)
  value.claims[0]!.quotes[0]!.segment = 's9'
  expect(
    parseStageExtraction('```json\n' + JSON.stringify(value) + '\n```', window).claims[0]!
      .quotes[0]!.segment,
  ).toBe('s1')
})
it.each([
  [
    'namespace',
    (v: typeof RAW_EXTRACTION) => {
      v.entities[0]!.ref = 'r1'
    },
  ],
  [
    'vocabulary',
    (v: typeof RAW_EXTRACTION) => {
      Object.assign(v.claims[0]!.links[0]!, { predicate: 'about' })
    },
  ],
  [
    'quote',
    (v: typeof RAW_EXTRACTION) => {
      v.claims[0]!.links[0]!.quote = 'unsupported'
    },
  ],
  [
    'date',
    (v: typeof RAW_EXTRACTION) => {
      Object.assign(v.claims[0]!, { validFrom: '2026-02-30' })
    },
  ],
  [
    'parent',
    (v: typeof RAW_EXTRACTION) => {
      v.parents[0] = { entity: 'n2', status: 'stated', claim: 'c1' }
    },
  ],
  [
    'missing parent',
    (v: typeof RAW_EXTRACTION) => {
      v.parents = []
    },
  ],
] as const)('rejects invalid %s without silently discarding it', (_name, change) => {
  const value = structuredClone(RAW_EXTRACTION)
  change(value)
  expect(() => parse(value)).toThrow()
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
