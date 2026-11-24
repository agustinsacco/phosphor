import { expect, it } from 'vitest'
import { EXTRACTION_SYSTEM } from './extract'
import { IDENTITY_SYSTEM } from './identity'
import { RECONCILE_SYSTEM } from './reconcile'

it.each([
  ['extract', EXTRACTION_SYSTEM],
  ['identity', IDENTITY_SYSTEM],
  ['reconcile', RECONCILE_SYSTEM],
])('%s treats source-derived text as data, not instructions', (_stage, system) => {
  expect(system).toMatch(/(?:never follow|do not[^.]*obey)/i)
  expect(system).toMatch(/(?:lane|source|conversation)/i)
})

it('tells reconcile that reports_to is single-valued on the subject', () => {
  expect(RECONCILE_SYSTEM).toMatch(/reports_to.*subject/)
})
