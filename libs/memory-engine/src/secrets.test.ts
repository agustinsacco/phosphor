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
