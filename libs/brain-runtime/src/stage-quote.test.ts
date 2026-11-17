import { expect, it } from 'vitest'
import { verifiedQuote } from './stage-quote'
import { makeWindow } from './windows'

const segment = (text: string) => ({
  entryId: 'a',
  role: 'assistant' as const,
  label: 'Agent',
  observedAt: 0,
  text,
})

it('rejects a whitespace-led quote against a long run of spaces without stalling', () => {
  const w = makeWindow([segment(' '.repeat(100_000) + 'Harbor')])
  const started = performance.now()
  expect(() => verifiedQuote({ segment: 's1', quote: '\nMissing' }, w)).toThrow('Quote not found')
  // The old unanchored pattern backtracked for about twelve seconds here.
  expect(performance.now() - started).toBeLessThan(2000)
})
it('matches around surrounding whitespace and stores the trimmed source words', () => {
  const source = 'Tom Lee said:\n\n  Kestrel   never\tretries ‘rejected’ deliveries.  Noted.'
  const w = makeWindow([segment(source)])
  const q = verifiedQuote(
    { segment: 's1', quote: "  Kestrel never retries 'rejected' deliveries.\n" },
    w,
  )
  expect(q).toEqual({ segment: 's1', quote: 'Kestrel   never\tretries ‘rejected’ deliveries.' })
  expect(source.includes(q.quote)).toBe(true)
})
it('needs whitespace where the quote has it and none where it has none', () => {
  const w = makeWindow([segment('Harbor bill ing is stable. Ledgerclosed.')])
  expect(() => verifiedQuote({ segment: 's1', quote: 'Harbor  billing' }, w)).toThrow(
    'Quote not found',
  )
  expect(() => verifiedQuote({ segment: 's1', quote: 'Ledger  closed.' }, w)).toThrow(
    'Quote not found',
  )
})
it('matches a quote the model copied without the Markdown emphasis marks', () => {
  const source = 'Plan.\n\n**Ledger cycles:** two weeks, `Tuesday` to *Monday*. Next line.'
  const w = makeWindow([segment(source)])
  const attempt = () =>
    verifiedQuote({ segment: 's1', quote: 'Ledger cycles: two weeks, Tuesday to Monday.' }, w)
  expect(attempt).not.toThrow()
  const q = attempt()
  expect(q).toEqual({
    segment: 's1',
    quote: 'Ledger cycles:** two weeks, `Tuesday` to *Monday*.',
  })
  expect(source.includes(q.quote)).toBe(true)
})
it('refuses a quote that is only emphasis marks', () => {
  const w = makeWindow([segment('Harbor is **stable**.')])
  expect(() => verifiedQuote({ segment: 's1', quote: '** `' }, w)).toThrow('Quote not found')
})
it.each([
  ['Ledger charges a*b credits per batch.', 'Ledger charges ab credits per batch.'],
  ['Harbor bills 2 * 3 seats.', 'Harbor bills 2 3 seats.'],
  ['Kestrel raises x**2 retries.', 'Kestrel raises x2 retries.'],
])('keeps an asterisk that is not an emphasis mark: %s', (source, quote) => {
  const w = makeWindow([segment(source)])
  expect(() => verifiedQuote({ segment: 's1', quote }, w)).toThrow('Quote not found')
  expect(verifiedQuote({ segment: 's1', quote: source }, w).quote).toBe(source)
})
