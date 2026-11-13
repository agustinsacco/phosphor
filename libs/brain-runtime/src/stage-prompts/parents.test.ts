import { expect, it } from 'vitest'
import { parentsPrompt } from './parents'
import { BRAIN_PREDICATES } from '@phosphor/shared/brain'
it('provides the full claim and entity contract to the independent parent call', () => {
  const prompt = parentsPrompt([], [], '[s1] user You\nHarbor is part of Kestrel.')
  for (const field of [
    '"epistemic"',
    '"validFrom"',
    '"validTo"',
    '"mentions"',
    '"links"',
    '"quotes"',
    '"branch"',
    '"namespace"',
    '"value"',
  ])
    expect(prompt).toContain(field)
  for (const predicate of BRAIN_PREDICATES) expect(prompt).toContain(predicate)
  expect(prompt).toContain('160 characters')
})
