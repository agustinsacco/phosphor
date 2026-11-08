import { expect, it } from 'vitest'
import {
  DEFAULT_BRAIN_PREFS,
  type BrainStatus,
  type BrainKnowledge,
  type BrainProposalView,
} from '@shared/brain'
import { createMockBrain } from './mockBrain'

it('models enable → download → queue → running → review subset → graph → forget', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  expect(await call('brain:status', [])).toMatchObject({
    prefs: { enabled: false },
    embedding: { phase: 'missing' },
  })
  expect(await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])).toMatchObject({
    embedding: { phase: 'downloading' },
  })
  now = 1000
  expect(await call('brain:status', [])).toMatchObject({
    embedding: { receivedBytes: 109363494.5 },
  })
  now = 6000
  const queued = (await call('brain:queue', [
    { sessionPath: '/demo/Harbor/lane.jsonl', title: 'Harbor billing' },
  ])) as BrainStatus
  const id = queued.jobs[0]!.id
  expect(queued.jobs[0]?.state).toBe('queued')
  expect(await call('brain:status', [])).toMatchObject({ jobs: [{ state: 'running' }] })
  now += 4000
  const proposal = (await call('brain:proposal', [id])) as BrainProposalView
  expect(proposal.memories).toHaveLength(2)
  await expect(call('brain:review', [id, [1], 999])).rejects.toThrow('Brain changed')
  expect(await call('brain:review', [id, [1], proposal.revision])).toMatchObject({
    counts: { memories: 1, entities: 2 },
    jobs: [],
  })
  const knowledge = (await call('brain:knowledge', [])) as BrainKnowledge
  expect(knowledge.memories[0]?.summary).toContain('Rina Okafor')
  expect(await call('brain:memory', [knowledge.memories[0]!.id])).toMatchObject({
    quotes: [{ quote: 'Rina Okafor owns Harbor billing migrations.' }],
  })
  expect(await call('brain:forget', [knowledge.memories[0]!.id])).toMatchObject({
    counts: { memories: 0, entities: 0 },
  })
})

it('cancels jobs, rejects all, retries downloads and removes only while off', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  await expect(call('brain:removeModel', [])).rejects.toThrow('Turn Brain off')
  now = 6000
  const lane = { sessionPath: '/demo/Harbor/cancel.jsonl', title: 'Harbor demo' }
  let queued = (await call('brain:queue', [lane])) as BrainStatus
  await expect(call('brain:queue', [lane])).rejects.toThrow('already queued')
  await call('brain:cancel', [queued.jobs[0]!.id])
  queued = (await call('brain:queue', [lane])) as BrainStatus
  await call('brain:status', [])
  now += 4000
  await call('brain:status', [])
  await call('brain:review', [queued.jobs[0]!.id, null, 0])
  expect(await call('brain:knowledge', [])).toMatchObject({ memories: [] })
  expect(await call('brain:setPrefs', [DEFAULT_BRAIN_PREFS])).toMatchObject({
    embedding: { phase: 'ready' },
  })
  expect(await call('brain:removeModel', [])).toMatchObject({ embedding: { phase: 'missing' } })
  expect(await call('brain:download', [])).toMatchObject({ embedding: { phase: 'downloading' } })
})

it('auto-approves when review is off', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ enabled: true, recall: true, review: false }])
  now = 6000
  await call('brain:queue', [{ sessionPath: '/demo/Harbor/auto.jsonl', title: 'Harbor auto' }])
  await call('brain:status', [])
  now += 4000
  expect(await call('brain:status', [])).toMatchObject({ jobs: [], counts: { memories: 2 } })
})
