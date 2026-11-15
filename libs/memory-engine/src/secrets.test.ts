import { expect, it } from 'vitest'
import { scrubExcerpt } from './secrets'

it('scrubs a long unbroken made-up answer without quadratic URL-prefix rescanning', () => {
  const text = 'x'.repeat(60_000) + ' Harbor token=harbor-secret'
  const start = performance.now()
  const result = scrubExcerpt(text)
  const elapsed = performance.now() - start
  expect(result).toBe('x'.repeat(60_000) + ' Harbor [redacted]')
  expect(elapsed).toBeLessThan(1000)
})

it('redacts conservative international and formatted phone numbers, not dates or ticket ids', () => {
  expect(scrubExcerpt('Call +1 (415) 555-0123 or (212) 555-0199.')).toBe(
    'Call [redacted] or [redacted].',
  )
  expect(scrubExcerpt('2026-11-06 Harbor-1234')).toBe('2026-11-06 Harbor-1234')
})

it('redacts international formatted phone numbers without treating long plain ids as contacts', () => {
  expect(scrubExcerpt('Call +44 20 7946 0958 or (415)5550123.')).toBe(
    'Call [redacted] or [redacted].',
  )
  expect(scrubExcerpt('Ledger id 123456789012')).toBe('Ledger id 123456789012')
})
