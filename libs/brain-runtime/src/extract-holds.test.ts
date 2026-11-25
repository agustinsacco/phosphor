import { afterEach, expect, it } from 'vitest'
import { extractJob } from './extract'
import { answerFor, pipelineSetup } from './__fixtures__/pipeline'
import { RAW_EXTRACTION } from './__fixtures__/lane'
import type { ModelCallInput } from './model-call'
import { parseStageExtraction } from './stage-parse'
import { makeWindow } from './windows'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
/** The fixture lane says "Rina Okafor owns Harbor billing. Tom Lee reviews schema changes." */
function answer(hold: unknown, validFrom?: string) {
  const value = structuredClone(RAW_EXTRACTION) as unknown as {
    entities: unknown[]
    claims: Record<string, unknown>[]
  }
  value.entities.push({
    ref: 'n3',
    label: 'Tom Lee',
    kind: 'person',
    aliases: [],
    description: '',
    keys: [],
  })
  value.claims.push({
    ...value.claims[0]!,
    ref: 'c2',
    text: 'Tom Lee reviews schema changes.',
    type: 'fact',
    validFrom: validFrom ?? null,
    mentions: ['n3'],
    links: [],
    quotes: [{ segment: 's1', quote: 'Tom Lee reviews schema changes.' }],
    hold,
  })
  return value
}
async function run(options: { hold: unknown; validFrom?: string; identity?: 'new' | 'uncertain' }) {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  if (options.identity === 'uncertain') {
    s.store.cards = [
      {
        id: 'stored-rina',
        label: 'Rina Okafor',
        kind: 'person',
        aliases: [],
        description: 'Harbor lead',
        neighbours: [],
        memories: 3,
      },
    ]
    s.store.matches = [[{ entityId: 'stored-rina', channel: 'name', score: 1 }]]
  }
  s.runner.mockImplementation(async (input: ModelCallInput) => ({
    text:
      input.stage === 'extract'
        ? JSON.stringify(answer(options.hold, options.validFrom))
        : input.stage === 'identity' && options.identity === 'uncertain'
          ? answerFor(input).replaceAll('"new"', '"uncertain"')
          : answerFor(input),
    usage: { tokens: 10, cost: 0 },
  }))
  await extractJob(s.job, new AbortController().signal, s.store, s.options, s.search)
  return s
}

it("keeps the model's hold on a claim through to the proposal, and ignores an unknown one", async () => {
  const held = await run({ hold: 'personal' })
  expect(held.store.saved.get(held.job.id)!.memories.map((m) => m.hold)).toEqual([null, 'personal'])
  const unknown = await run({ hold: 'secret' })
  expect(unknown.store.saved.get(unknown.job.id)!.memories.map((m) => m.hold)).toEqual([null, null])
})

it.each([
  ['temporary', 2, 'kept', 'Saved until 2026-11-20'],
  ['personal', 1, 'dropped', 'About a person: never saved'],
] as const)('records the automatic %s decision', async (hold, memories, status, reason) => {
  const s = await run({ hold })
  expect(s.job).toMatchObject({ state: 'done', memories })
  expect(s.store.extraction(s.job.id).outcomes).toContainEqual(
    expect.objectContaining({ candidate: 'w1:c2', status, reason }),
  )
})

it('saves a required identity with a guess for Brain Agent', async () => {
  const s = await run({ hold: null, identity: 'uncertain' })
  expect(s.job.state).toBe('done')
  expect(s.store.saved.get(s.job.id)?.entities).toContainEqual(
    expect.objectContaining({ required: true, decision: 'uncertain', candidates: ['stored-rina'] }),
  )
})

it('marks a claim the backstop finds temporary or personal when the model did not', () => {
  const said = Date.UTC(2026, 10, 18)
  const text = 'Rina Okafor will be on leave in December. Harbor still bills weekly.'
  const window = makeWindow([{ entryId: 'u', role: 'user', label: 'You', observedAt: said, text }])
  const claim = (ref: string, sentence: string, quote: string, mentions: string[]) => ({
    ref,
    text: sentence,
    type: 'fact',
    epistemic: 'reported',
    mentions,
    links: [],
    validFrom: null,
    validTo: null,
    branch: false,
    quotes: [{ segment: 's1', quote }],
  })
  const parsed = parseStageExtraction(
    JSON.stringify({
      entities: [RAW_EXTRACTION.entities[0], RAW_EXTRACTION.entities[1]],
      claims: [
        claim('c1', 'Rina Okafor will be on leave in December.', 'on leave in December', ['n1']),
        claim('c2', 'Harbor still bills weekly.', 'Harbor still bills weekly.', ['n2']),
      ],
      parents: [],
    }),
    window,
  )
  expect(parsed.claims.map((c) => c.hold)).toEqual(['personal', 'temporary'])
})

it('records the derived temporary end relative to a future start', async () => {
  const s = await run({ hold: 'temporary', validFrom: '2027-01-05' })
  expect(s.store.extraction(s.job.id).outcomes).toContainEqual(
    expect.objectContaining({ candidate: 'w1:c2', reason: 'Saved until 2027-01-19' }),
  )
})
