import { expect, it } from 'vitest'
import { EXTRACTION_SYSTEM } from './extract'
import { IDENTITY_SYSTEM } from './identity'
import { PARENTS_SYSTEM } from './parents'
import { RECONCILE_SYSTEM } from './reconcile'

it.each([
  ['extract', EXTRACTION_SYSTEM],
  ['identity', IDENTITY_SYSTEM],
  ['parents', PARENTS_SYSTEM],
  ['reconcile', RECONCILE_SYSTEM],
])('%s treats source-derived text as data, not instructions', (_stage, system) => {
  expect(system).toMatch(/(?:never follow|do not[^.]*obey)/i)
  expect(system).toMatch(/(?:lane|source)/i)
})
