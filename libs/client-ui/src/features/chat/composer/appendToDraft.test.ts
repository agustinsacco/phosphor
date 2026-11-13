import { expect, it } from 'vitest'
import { joinDraft } from './appendToDraft'

it('adds a link after a space and a paragraph after a blank line, never replacing', () => {
  expect(joinDraft('', 'https://x')).toBe('https://x ')
  expect(joinDraft('see', 'https://x')).toBe('see https://x ')
  expect(joinDraft('see ', 'https://x')).toBe('see https://x ')
  expect(joinDraft('', 'Fix it.\nThen push.')).toBe('Fix it.\nThen push.')
  expect(joinDraft('first\n', 'Fix it.\nThen push.')).toBe('first\n\nFix it.\nThen push.')
})
