import { expect, it } from 'vitest'
import { parseStageExtraction } from './stage-parse'
import { extractPrompt } from './stage-prompts/extract'
import { makeWindow } from './windows'
import { RAW_EXTRACTION } from './__fixtures__/lane'

const window = makeWindow([
  {
    entryId: 'u',
    role: 'user',
    label: 'You',
    observedAt: 0,
    text: 'Rina Okafor owns Harbor billing.',
  },
])
const claims = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ ...RAW_EXTRACTION.claims[0]!, ref: `c${i + 1}` }))
const parse = (count: number) =>
  parseStageExtraction(JSON.stringify({ ...RAW_EXTRACTION, claims: claims(count) }), window)

it('notes a part that returned exactly the 25-claim cap, keeping every claim', () => {
  const result = parse(25)
  expect(result.claims).toHaveLength(25)
  expect(result.outcomes).toEqual([
    {
      candidate: 'cap',
      summary: 'This part returned 25 claims, the most one part may keep',
      status: 'noted',
      reason: 'More claims may have passed the test than one part can return.',
    },
  ])
})

it('notes nothing below the cap', () => {
  expect(parse(24).outcomes).toBeUndefined()
})

it('says 25 is a ceiling, not a quota', () => {
  const prompt = extractPrompt(makeWindow([]), [])
  expect(prompt).toContain('up to 25')
  expect(prompt).toContain('25 is a ceiling, not a target: most parts keep fewer than ten.')
})

it('keeps tables, flags, service accounts, scheduled jobs and contract clauses out of entities', () => {
  expect(extractPrompt(makeWindow([]), [])).toContain(
    'A database table, feature flag, service account, scheduled job or contract clause is not an entity either, unless people discuss it as a thing someone owns.',
  )
})
