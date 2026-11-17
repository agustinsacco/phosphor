import { expect, it } from 'vitest'
import { brainBriefing, formatBrainRecall } from './format'
import { HARBOR_RECALL } from './__fixtures__/recall'

it('numbers only displayed memories, in section order, without changing search text', () => {
  const sample = HARBOR_RECALL.hits[0]!
  const hits = [
    { ...sample, memory: { ...sample.memory, id: 'harbor-fact', type: 'fact' as const } },
    { ...sample, memory: { ...sample.memory, id: 'harbor-risk', type: 'risk' as const } },
  ]
  const result = { ...HARBOR_RECALL, hits, paths: [] }
  const briefing = brainBriefing(result, '/projects/harbor', 6000, 0)
  expect([...briefing.refs]).toEqual([
    [1, 'harbor-risk'],
    [2, 'harbor-fact'],
  ])
  expect(briefing.text).toBe(formatBrainRecall(result, '/projects/harbor', 6000, 0))
  expect(brainBriefing(result, undefined, 0).refs.size).toBe(0)
  expect(brainBriefing({ ...result, status: 'no_match' }).refs.size).toBe(0)
  expect(brainBriefing({ ...result, status: 'unavailable' }).refs.size).toBe(0)
})
