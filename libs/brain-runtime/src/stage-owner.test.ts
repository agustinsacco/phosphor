import { afterEach, expect, it } from 'vitest'
import { parseStageExtraction } from './stage-parse'
import { makeWindow } from './windows'
import type { Registry } from './stage-types'
import { extractJob } from './extract'
import { answerFor, pipelineSetup } from './__fixtures__/pipeline'
import { RAW_EXTRACTION } from './__fixtures__/lane'
import type { ModelCallInput } from './model-call'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const source =
  'I want short bullet updates. My team reviews Harbor on Fridays. Rina Okafor here, by the way.'
const window = makeWindow([
  { entryId: 'u', role: 'user', label: 'You', observedAt: 0, text: source },
])
const rina = {
  ref: 'n1',
  label: 'Rina Okafor',
  kind: 'person',
  aliases: [],
  description: 'Harbor lead',
  keys: [],
}
const claim = (ref: string, text: string, quote: string) => ({
  ref,
  text,
  type: 'preference',
  epistemic: 'reported',
  mentions: [],
  links: [],
  validFrom: null,
  validTo: null,
  branch: false,
  quotes: [{ segment: 's1', quote }],
})
const parse = (entities: unknown[], claims: unknown[], registry: Registry = []) =>
  parseStageExtraction(JSON.stringify({ entities, claims, parents: [] }), window, registry)

it("names the owner in place of a leading 'The user', and mentions her once", () => {
  const result = parse(
    [{ ...rina, user: true }],
    [
      claim('c1', 'The user wants short bullet updates.', 'I want short bullet updates.'),
      claim('c2', "The user's team reviews Harbor on Fridays.", 'My team reviews Harbor'),
    ],
  )
  expect(result.claims.map((c) => [c.text, c.mentions])).toEqual([
    ['Rina Okafor wants short bullet updates.', ['n1']],
    ["Rina Okafor's team reviews Harbor on Fridays.", ['n1']],
  ])
})

it('uses the owner an earlier part marked, through the registry', () => {
  // An earlier part's entity, as the registry carries it into the next prompt.
  const registry = JSON.parse(JSON.stringify([{ ...rina, ref: 'r1', user: true }])) as Registry
  const result = parse(
    [],
    [claim('c1', 'The user wants short bullet updates.', 'I want short bullet updates.')],
    registry,
  )
  expect(result.claims[0]).toMatchObject({
    text: 'Rina Okafor wants short bullet updates.',
    mentions: ['r1'],
  })
})

it('leaves the sentence alone when no person, or more than one, is marked as the user', () => {
  const sentence = 'The user wants short bullet updates.'
  const unmarked = parse([rina], [claim('c1', sentence, 'I want short bullet updates.')])
  expect(unmarked.claims[0]).toMatchObject({ text: sentence, mentions: [] })
  const tom = { ...rina, ref: 'n2', label: 'Tom Lee', user: true }
  const twice = parse(
    [{ ...rina, user: true }, tom],
    [claim('c1', sentence, 'I want short bullet updates.')],
  )
  expect(twice.claims[0]).toMatchObject({ text: sentence, mentions: [] })
  expect(twice.entities.some((e) => 'user' in e)).toBe(false)
  const project = { ...rina, ref: 'n3', label: 'Harbor', kind: 'project', user: true }
  const notPerson = parse([project], [claim('c1', sentence, 'I want short bullet updates.')])
  expect(notPerson.claims[0]).toMatchObject({ text: sentence, mentions: [] })
  expect('user' in notPerson.entities[0]!).toBe(false)
})

it("rewrites only a leading, capitalised 'The user'", () => {
  const result = parse(
    [{ ...rina, user: true }],
    [
      claim('c1', 'Harbor updates go to the user in bullets.', 'I want short bullet updates.'),
      claim('c2', 'The users of Harbor want bullets.', 'I want short bullet updates.'),
    ],
  )
  expect(result.claims.map((c) => [c.text, c.mentions])).toEqual([
    ['Harbor updates go to the user in bullets.', []],
    ['The users of Harbor want bullets.', []],
  ])
})

it('carries the trusted user flag into the saved owner mark', async () => {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  const marked = structuredClone(RAW_EXTRACTION)
  Object.assign(marked.entities[0]!, { user: true })
  s.runner.mockImplementation(async (input: ModelCallInput) => ({
    text: input.stage === 'extract' ? JSON.stringify(marked) : answerFor(input),
    usage: { tokens: 10, cost: 0 },
  }))
  await extractJob(s.job, new AbortController().signal, s.store, s.options, s.search)
  const identityPrompt = s.runner.mock.calls.find(([input]) => input.stage === 'identity')
  expect(identityPrompt?.[0].prompt).not.toContain('"user"')
  const stored = s.store.saved.get(s.job.id)!
  expect(stored.entities.map((e) => e.label)).toContain('Rina Okafor')
  expect(stored.entities.some((e) => 'user' in e)).toBe(false)
  expect(stored.entities.find((e) => e.label === 'Rina Okafor')?.owner).toBe(true)
})
