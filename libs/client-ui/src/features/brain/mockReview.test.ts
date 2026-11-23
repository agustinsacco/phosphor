import { expect, it } from 'vitest'
import type { BrainReviewDecision, BrainStatus } from '@shared/brain'
import { BRAIN_DECISION_REFUSALS, brainRequiredAnswerRefusal } from '@shared/brain-review'
import { mockBrainHarness as createMockBrain } from './mockBrain.test-support'

const REVIEW = 'harbor-demo-review'
const decide = (patch: Partial<Record<keyof BrainReviewDecision, unknown>> = {}) => ({
  memories: [0],
  identities: { rina: 'rina' },
  groups: [],
  descriptions: [],
  confirmations: [],
  ...patch,
})
/** The harness's review: a required "Rina" question and two held claims. */
function harness() {
  const call = createMockBrain(() => 0, { flagAfterMs: 20000, demoReviews: true })
  const review = (decision: unknown) => call.decideRead([REVIEW, decision, 0])
  const state = async () => {
    const status = (await call('brain:status', [])) as BrainStatus
    return { counts: status.counts, pending: status.jobs.some((job) => job.id === REVIEW) }
  }
  return { call, review, state }
}

it('refuses the shapes and sizes Desktop refuses, before anything changes', async () => {
  const { review, state } = harness()
  const before = await state()
  const ref = 'r'.repeat(65)
  for (const decision of [
    decide({ memories: [0, 0] }),
    decide({ groups: [0, 0] }),
    decide({ memories: Array.from({ length: 401 }, (_, i) => i) }),
    decide({ memories: [1.5] }),
    decide({
      identities: Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`r${i}`, 'new'])),
    }),
    decide({ identities: { [ref]: 'new' } }),
    decide({ descriptions: Array.from({ length: 401 }, () => 'rina') }),
    decide({ extra: true } as never),
  ])
    await expect(review(decision)).rejects.toThrow(BRAIN_DECISION_REFUSALS.selection)
  expect(await state()).toEqual(before)
})

it("refuses what the engine refuses, in the engine's words, before anything changes", async () => {
  const { review, state } = harness()
  const before = await state()
  const { index, identity, description } = BRAIN_DECISION_REFUSALS
  for (const [decision, sentence] of [
    [decide({ memories: [0, 9] }), index],
    [decide({ groups: [3] }), index],
    [decide({ identities: { rina: 'rina', nobody: 'new' } }), identity],
    [decide({ identities: { rina: 'no-such-record' } }), identity],
    [decide({ descriptions: ['nobody'] }), description],
  ] as const)
    await expect(review(decision)).rejects.toThrow(sentence)
  expect(await state()).toEqual(before)
})

it('refuses saving a claim that names the unanswered required "Rina", and creates nobody', async () => {
  const { review, state } = harness()
  const before = await state()
  await expect(review(decide({ memories: [1], identities: {} }))).rejects.toThrow(
    brainRequiredAnswerRefusal('Rina'),
  )
  expect(await state()).toEqual(before)
  // Nothing approved names her, so her question may stay open.
  await review(decide({ memories: [0], identities: {} }))
  expect((await state()).pending).toBe(false)
})

it('saves held claims only when ticked', async () => {
  const { call, review } = harness()
  await review(decide({ memories: [0, 1] }))
  const find = async (query: string) =>
    ((await call('brain:find', [query, 8])) as { memories: { summary: string }[] }).memories.map(
      (memory) => memory.summary,
    )
  expect(await find('Friday')).not.toContain('Tom Lee is out until Friday.')
  expect(await find('tired')).not.toContain('Rina sounded tired on the call.')
  const ticked = harness()
  await ticked.review(decide({ memories: [0, 1, 2] }))
  expect(
    ((await ticked.call('brain:find', ['Friday', 8])) as { memories: { summary: string }[] })
      .memories[0]?.summary,
  ).toBe('Tom Lee is out until Friday.')
})
