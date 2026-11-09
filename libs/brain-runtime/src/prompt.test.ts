import { expect, it } from 'vitest'
import { extractionPrompt } from './prompt'
import { HARBOR_RECALL } from '../../brain-client/src/__fixtures__/recall'

it('fills the extraction instruction with known ids, sentences, labels and aliases', () => {
  const prompt = extractionPrompt({
    entities: HARBOR_RECALL.entities,
    memories: HARBOR_RECALL.hits.map((h) => h.memory),
  })
  expect(prompt).toContain('- [ownership] Rina Okafor owns Harbor billing.')
  expect(prompt).toContain('- rina: Rina Okafor (person; aliases Rina)')
  expect(prompt).toContain('At most 20 memories and 15 new entities.')
  expect(prompt).not.toContain('{{')
  expect(prompt).toContain('Never restate memories just to repeat them.')
  expect(prompt).toContain(
    'When this lane itself states or relies on an existing memory again, outside brain_search or brain_related output, include it again with a fresh quote from this lane so Brain can re-confirm it.',
  )
  expect(prompt).toContain(
    'When this lane changed something, set "supersedes" to the old memory\'s id.',
  )
  expect(prompt).toContain('Do not call tools')
  expect(prompt).toContain('Each quote is at most 160 characters')
  expect(prompt).toContain('"supersedes":null')
})

it('shows empty sections explicitly rather than leaking placeholders', () => {
  const prompt = extractionPrompt({ entities: [], memories: [] })
  expect(prompt.match(/\(none\)/g)).toHaveLength(2)
  expect(prompt).not.toContain('{{')
})
