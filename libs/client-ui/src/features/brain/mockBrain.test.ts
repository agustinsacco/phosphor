import { expect, it } from 'vitest'
import {
  DEFAULT_BRAIN_PREFS,
  type BrainStatus,
  type BrainProposalView,
  type BrainMemoryPage,
  type BrainEntityView,
  type BrainConnectionPage,
  type BrainPaths,
} from '@shared/brain'
import { createMockBrain } from './mockBrain'

it('models enable → download → queue → review decision → memory → forget', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  const before = (await call('brain:status', [])) as BrainStatus
  expect(before.prefs.enabled).toBe(false)
  expect(await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])).toMatchObject({
    embedding: { phase: 'downloading' },
  })
  now = 6000
  const queued = (await call('brain:queue', [
    { sessionPath: '/demo/Harbor/lane.jsonl', title: 'Harbor planning' },
  ])) as BrainStatus
  const id = queued.jobs.at(-1)!.id
  expect(await call('brain:status', [])).toMatchObject({
    jobs: expect.arrayContaining([
      expect.objectContaining({
        state: 'running',
        progress: { stage: 'extract', done: 1, total: 4 },
      }),
    ]),
  })
  now += 4000
  const proposal = (await call('brain:proposal', [id])) as BrainProposalView
  expect(proposal.identities.some((i) => i.decision === 'uncertain')).toBe(true)
  await expect(
    call('brain:review', [id, { memories: [0], identities: {}, groups: [] }, 999]),
  ).rejects.toThrow('Brain changed')
  expect(
    await call('brain:review', [
      id,
      { memories: [0], identities: {}, groups: [] },
      proposal.revision,
    ]),
  ).toMatchObject({ counts: { memories: before.counts.memories + 1 } })
  const page = (await call('brain:entityMemories', ['ledger', {}, null])) as BrainMemoryPage
  const saved = page.memories.find((m) => m.jobId === id)!
  expect(await call('brain:memory', [saved.id])).toMatchObject({
    quotes: [{ quote: 'Harbor Ledger is built for Harbor.' }],
  })
  expect(await call('brain:forget', [saved.id])).toMatchObject({
    counts: { memories: before.counts.memories },
  })
})

it('pages connections and memories without repeats and supports paths in both directions', async () => {
  const call = createMockBrain()
  const entity = (await call('brain:entity', ['harbor'])) as BrainEntityView
  const group = entity.groups.find((g) => g.predicate === 'part_of')!
  expect(group.items).toHaveLength(20)
  const more = (await call('brain:connections', [
    'harbor',
    'part_of',
    'in',
    group.next,
  ])) as BrainConnectionPage
  expect(more.items.length).toBeGreaterThan(0)
  expect(more.next).toBeNull()
  expect(new Set([...group.items, ...more.items].map((i) => i.link.id)).size).toBe(group.total)
  const first = (await call('brain:entityMemories', ['harbor', {}, null])) as BrainMemoryPage
  const second = (await call('brain:entityMemories', ['harbor', {}, first.next])) as BrainMemoryPage
  expect(new Set([...first.memories, ...second.memories].map((m) => m.id)).size).toBe(
    first.memories.length + second.memories.length,
  )
  const paths = (await call('brain:path', ['harbor', 'rina'])) as BrainPaths
  expect(paths.paths[0]!.map((link) => link.predicate)).toEqual(['for_customer', 'owns'])
  for (const link of paths.paths[0]!)
    expect(paths.memories.some((m) => m.id === link.memoryId)).toBe(true)
})

it('cancels jobs, rejects all, retries downloads, removes only while off, and resets knowledge', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  await expect(call('brain:removeModel', [])).rejects.toThrow('Turn Brain off')
  now = 6000
  const lane = { sessionPath: '/demo/Harbor/cancel.jsonl', title: 'Harbor demo' }
  let queued = (await call('brain:queue', [lane])) as BrainStatus
  await expect(call('brain:queue', [lane])).rejects.toThrow('already queued')
  await call('brain:cancel', [queued.jobs.at(-1)!.id])
  queued = (await call('brain:queue', [lane])) as BrainStatus
  await call('brain:status', [])
  now += 4000
  await call('brain:status', [])
  await call('brain:review', [queued.jobs.at(-1)!.id, null, 0])
  expect(await call('brain:setPrefs', [DEFAULT_BRAIN_PREFS])).toMatchObject({
    embedding: { phase: 'ready' },
  })
  expect(await call('brain:removeModel', [])).toMatchObject({ embedding: { phase: 'missing' } })
  expect(await call('brain:download', [])).toMatchObject({ embedding: { phase: 'downloading' } })
  expect(await call('brain:reset', [])).toMatchObject({
    counts: { memories: 0, entities: 0 },
    prefs: DEFAULT_BRAIN_PREFS,
  })
})

it('merges mentions and links, and auto-approves when review is off', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  await call('brain:merge', ['tom', 'rina'])
  const rina = (await call('brain:entity', ['rina'])) as BrainEntityView
  expect(rina.entity.aliases).toContain('Tom Lee')
  await expect(call('brain:entity', ['tom'])).rejects.toThrow('Entity not found')
  const before = (await call('brain:status', [])) as BrainStatus
  await call('brain:setPrefs', [{ enabled: true, recall: true, review: false }])
  now = 6000
  await call('brain:queue', [{ sessionPath: '/demo/Harbor/auto.jsonl', title: 'Harbor auto' }])
  await call('brain:status', [])
  now += 4000
  expect(await call('brain:status', [])).toMatchObject({
    counts: { memories: before.counts.memories + 2 },
  })
})

it('can extract and approve again after resetting every entity and memory', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ enabled: true, recall: true, review: true }])
  now = 6000
  await call('brain:status', [])
  await call('brain:reset', [])
  const queued = (await call('brain:queue', [
    { sessionPath: '/demo/Harbor/after-reset.jsonl', title: 'Harbor after reset' },
  ])) as BrainStatus
  const id = queued.jobs.at(-1)!.id
  await call('brain:status', [])
  now += 4000
  const proposal = (await call('brain:proposal', [id])) as BrainProposalView
  await expect(
    call('brain:review', [id, { memories: [0], identities: {}, groups: [] }, proposal.revision]),
  ).resolves.toMatchObject({ counts: { memories: 1, entities: 2 } })
})

it('requeues a stale proposal and returns it to review after recomputing', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ enabled: true, review: true, recall: true }])
  now = 6000
  await call('brain:status', [])
  const id = 'harbor-demo-review'
  await call('brain:merge', ['tom', 'rina'])
  await expect(call('brain:proposal', [id])).rejects.toThrow(
    'Brain changed; refreshing this review',
  )
  expect(await call('brain:status', [])).toMatchObject({
    jobs: expect.arrayContaining([expect.objectContaining({ id, state: 'running' })]),
  })
  now += 4000
  expect(await call('brain:proposal', [id])).toMatchObject({
    revision: 1,
    job: { state: 'review' },
  })
})
