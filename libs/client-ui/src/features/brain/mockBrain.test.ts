import { expect, it } from 'vitest'
import { brainLaneNeverRead } from '@phosphor/shared/brain-never-read'
import {
  DEFAULT_BRAIN_PREFS,
  type BrainHistory,
  type BrainStatus,
  type BrainExtractionView,
  type BrainProposalView,
  type BrainMemoryPage,
  type BrainEntityView,
  type BrainConnectionPage,
  type BrainPaths,
  type BrainRecentMemories,
} from '@shared/brain'
import { mockBrainHarness as createMockBrain } from './mockBrain.test-support'

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
  await call('brain:status', [])
  const proposal = (await call('brain:proposal', [id])) as BrainProposalView
  expect(proposal.identities.some((i) => i.decision === 'uncertain')).toBe(true)
  await expect(
    call.decideRead([
      id,
      { descriptions: [], confirmations: [], memories: [0], identities: {}, groups: [] },
      999,
    ]),
  ).rejects.toThrow('Brain changed')
  expect(
    await call.decideRead([
      id,
      { descriptions: [], confirmations: [], memories: [0], identities: {}, groups: [] },
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
  await call.decideRead([queued.jobs.at(-1)!.id, null, 0])
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
  await call('brain:merge', [
    'tom',
    'rina',
    ((await call('brain:status', [])) as BrainStatus).revision,
  ])
  const rina = (await call('brain:entity', ['rina'])) as BrainEntityView
  expect(rina.entity.aliases).toContain('Tom Lee')
  expect(await call('brain:entity', ['tom'])).toMatchObject({ entity: { id: 'rina' } })
  const before = (await call('brain:status', [])) as BrainStatus
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true, review: false }])
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
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  now = 6000
  await call('brain:status', [])
  await call('brain:reset', [])
  const queued = (await call('brain:queue', [
    { sessionPath: '/demo/Harbor/after-reset.jsonl', title: 'Harbor after reset' },
  ])) as BrainStatus
  const id = queued.jobs.at(-1)!.id
  await call('brain:status', [])
  now += 4000
  await call('brain:status', [])
  const proposal = (await call('brain:proposal', [id])) as BrainProposalView
  await expect(
    call.decideRead([
      id,
      { descriptions: [], confirmations: [], memories: [0], identities: {}, groups: [] },
      proposal.revision,
    ]),
  ).resolves.toMatchObject({ counts: { memories: 1, entities: 2 } })
})

it('returns the stored stale proposal without changing the waiting job after a Knowledge edit', async () => {
  const call = createMockBrain(() => 6000)
  const id = 'harbor-demo-review'
  const before = (await call('brain:proposal', [id])) as BrainProposalView
  await call('brain:describe', ['ledger', 'Harbor ledger.', before.revision])
  await expect(call('brain:proposal', [id])).resolves.toEqual(before)
  const status = (await call('brain:status', [])) as BrainStatus
  expect(status.jobs.find((job) => job.id === id)).toEqual(before.job)
})

it('exposes the links call beside extraction in the invented extraction view', async () => {
  const call = createMockBrain()
  const view = await call('brain:extraction', ['harbor-demo-review'])
  expect(view).toMatchObject({
    calls: [
      { stage: 'extract' },
      { stage: 'links', answer: expect.stringContaining('for_customer') },
    ],
    prompts: [expect.any(String), expect.stringContaining('relationships')],
  })
})

it('carries and freezes the selected reader model in browser mock jobs', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  expect(await call('brain:status', [])).toMatchObject({ prefs: { model: null } })
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true, model: 'harbor/reader' }])
  now = 6000
  await call('brain:reset', [])
  const queued = (await call('brain:queue', [
    { sessionPath: '/demo/Harbor/reader.jsonl', title: 'Harbor reader' },
  ])) as BrainStatus
  const id = queued.jobs[0]!.id
  expect(await call('brain:status', [])).toMatchObject({
    jobs: [expect.objectContaining({ model: 'harbor/reader' })],
  })
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true, model: 'ledger/reader' }])
  now += 5000
  expect(await call('brain:extraction', [id])).toMatchObject({
    model: 'harbor/reader',
    thinking: 'medium',
  })
})
it('keeps finished reads in history and replaces the mocked lane only on approval', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  now = 6000
  await call.decideRead([
    'harbor-demo-review',
    { descriptions: [], confirmations: [], memories: [0], identities: {}, groups: [] },
    0,
  ])
  const history = await call('brain:history', [20]).catch(String)
  expect(history).toMatchObject({ items: [{ job: { id: 'harbor-demo-review' } }], more: false })
  const queued = (await call('brain:reread', ['harbor-demo-review'])) as BrainStatus
  expect(queued.jobs.at(-1)?.replaces).toBe('harbor-demo-review')
  const count = queued.counts.memories
  await call('brain:status', [])
  now += 4000
  await call('brain:status', [])
  const id = queued.jobs.at(-1)!.id
  const proposal = (await call('brain:proposal', [id])) as BrainProposalView
  expect(proposal.replacingMemories).toBe(count)
  const saved = (await call.decideRead([
    id,
    { descriptions: [], confirmations: [], memories: [0], identities: {}, groups: [] },
    proposal.revision,
  ])) as BrainStatus
  expect(saved.counts.memories).toBe(1)
  // Both reads stay listed; Read again replaced every memory of the first one.
  expect(await call('brain:history', [20])).toMatchObject({
    items: [
      { job: { id }, memories: 1, replaceable: 1 },
      { job: { id: 'harbor-demo-review' }, memories: 0, replaceable: 1 },
    ],
  })
})

it('marks forgotten links removed in a finished mocked extraction', async () => {
  const call = createMockBrain()
  await call.decideRead([
    'harbor-demo-review',
    { descriptions: [], confirmations: [], memories: [0], identities: {}, groups: [] },
    0,
  ])
  const view = (await call('brain:extraction', ['harbor-demo-review'])) as BrainExtractionView
  await call('brain:forget', [view.memories[0]!.id])
  expect(await call('brain:extraction', ['harbor-demo-review'])).toMatchObject({
    outcomes: [expect.anything(), expect.anything()],
    job: { state: 'done' },
  })
  const after = (await call('brain:extraction', ['harbor-demo-review'])) as BrainExtractionView
  expect(after.outcomes[0]).toMatchObject({ memoryId: view.memories[0]!.id, removed: true })
})

it('serves both browse reads with paging, kinds and memories learned from an approved mock read', async () => {
  const call = createMockBrain()
  const all = await call('brain:entities', [null, 0, 1, 'connected'])
  expect(all).toMatchObject({
    items: [{ entity: { id: 'harbor' }, memories: expect.any(Number) }],
    more: true,
    kinds: expect.arrayContaining(['person', 'organization']),
  })
  expect(await call('brain:entities', ['person', 0, 1, 'connected'])).toMatchObject({
    items: [{ entity: { kind: 'person' } }],
    more: true,
  })
  expect(await call('brain:entities', ['person', 1, 1, 'connected'])).toMatchObject({
    items: [{ entity: { kind: 'person' } }],
    more: false,
  })
  await call.decideRead([
    'harbor-demo-review',
    { descriptions: [], confirmations: [], memories: [0], identities: {}, groups: [] },
    0,
  ])
  const read = (await call('brain:extraction', ['harbor-demo-review'])) as BrainExtractionView
  expect(await call('brain:recent', [10])).toMatchObject({
    items: [
      {
        id: read.memories[0]!.id,
        originTitle: 'Harbor identity review',
        learnedAt: expect.any(Number),
      },
    ],
  })
})

it('orders recent memories by finished job and caps eligibility at the newest twenty done jobs', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  const expected: string[] = []
  for (let index = 0; index < 22; index++) {
    now = 1_000_000 - index * 10000
    const status = (await call('brain:queue', [
      { sessionPath: `/demo/Harbor/read-${index}.jsonl`, title: `Harbor ${index}` },
    ])) as BrainStatus
    const id = status.jobs.at(-1)!.id
    await call('brain:status', [])
    now += 5000
    await call('brain:status', [])
    const proposal = (await call('brain:proposal', [id])) as BrainProposalView
    await call.decideRead([
      id,
      { descriptions: [], confirmations: [], memories: [0, 1], identities: {}, groups: [] },
      proposal.revision,
    ])
    expected.push(`${id}-1`, `${id}-0`)
  }
  const recent = (await call('brain:recent', [50])) as BrainRecentMemories
  expect(recent.items.map((item) => item.id)).toEqual(expected.slice(0, 40))
})

it('queues a lane it read before from where that read ended, and Read again from the start', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  now = 6000
  const decision = {
    descriptions: [],
    confirmations: [],
    memories: [0],
    identities: {},
    groups: [],
  }
  await call.decideRead(['harbor-demo-review', decision, 0])
  const read = ((await call('brain:history', [20])) as BrainHistory).items[0]!.job
  const lane = { sessionPath: read.sessionPath, title: read.title }
  const queued = ((await call('brain:queue', [lane])) as BrainStatus).jobs.at(-1)!
  expect(queued).toMatchObject({ fromLeafId: read.leafId, sessionId: read.sessionId })
  expect(queued.leafId).not.toBe(read.leafId)
  await call('brain:cancel', [queued.id])
  const again = ((await call('brain:reread', [read.id])) as BrainStatus).jobs.at(-1)!
  expect(again).toMatchObject({ fromLeafId: null, replaces: read.id })
})

it('moves a rejected read into history, as Desktop does, and continues the lane after it', async () => {
  const call = createMockBrain(() => 6000)
  const status = (await call.decideRead(['harbor-demo-review', null, 0])) as BrainStatus
  expect(status.jobs.map((job) => job.id)).not.toContain('harbor-demo-review')
  expect(status.readSessionIds).toContain('harbor-lane')
  const history = (await call('brain:history', [20])) as BrainHistory
  expect(history.items).toEqual([
    expect.objectContaining({
      job: expect.objectContaining({
        id: 'harbor-demo-review',
        state: 'rejected',
        finishedAt: 6000,
      }),
      memories: 0,
    }),
  ])
  await expect(call('brain:reread', ['harbor-demo-review'])).rejects.toThrow(
    'Only finished Brain reads can be read again.',
  )
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  const lane = { sessionPath: '/demo/Harbor/planning-demo.jsonl', title: 'Harbor' }
  const queued = ((await call('brain:queue', [lane])) as BrainStatus).jobs.at(-1)!
  expect(queued.fromLeafId).toBe(history.items[0]!.job.leafId)
})

it('keeps the earlier read when Read again is rejected, and lists both', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  const decision = {
    descriptions: [],
    confirmations: [],
    memories: [0],
    identities: {},
    groups: [],
  }
  await call.decideRead(['harbor-demo-review', decision, 0])
  const read = ((await call('brain:history', [20])) as BrainHistory).items[0]!.job
  const again = ((await call('brain:reread', [read.id])) as BrainStatus).jobs.at(-1)!
  now = 6000
  await call('brain:status', [])
  now += 4000
  const status = (await call('brain:status', [])) as BrainStatus
  expect(status.jobs.find((job) => job.id === again.id)?.state).toBe('review')
  await call.decideRead([again.id, null, status.revision])
  const history = (await call('brain:history', [20])) as BrainHistory
  expect(history.items.map((item) => [item.job.id, item.job.state, item.memories])).toEqual([
    [again.id, 'rejected', 0],
    [read.id, 'done', 1],
  ])
})

it('refuses to queue or read again a lane Brain never reads, and drops its queued read', async () => {
  const call = createMockBrain(() => 0)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  const titled = { sessionPath: '/demo/Rina/weekly.jsonl', title: 'Rina Okafor 1:1' }
  await expect(call('brain:queue', [titled])).rejects.toThrow('its title matches a rule')
  const lane = { sessionPath: '/demo/Harbor/off.jsonl', title: 'Harbor off' }
  const queued = ((await call('brain:queue', [lane])) as BrainStatus).jobs.at(-1)!
  const status = (await call('brain:neverRead', [queued.sessionId, true])) as BrainStatus
  expect(status.jobs.map((job) => job.id)).not.toContain(queued.id)
  await expect(call('brain:queue', [lane])).rejects.toThrow('Brain is set not to read this lane.')
  const decision = {
    descriptions: [],
    confirmations: [],
    memories: [0],
    identities: {},
    groups: [],
  }
  await call.decideRead(['harbor-demo-review', decision, 0])
  await call('brain:neverRead', ['harbor-lane', true])
  await expect(call('brain:reread', ['harbor-demo-review'])).rejects.toThrow(
    'Brain is set not to read this lane.',
  )
})

it('refuses a review decision Desktop would refuse', async () => {
  const call = createMockBrain(() => 0)
  for (const decision of [
    { memories: [0], identities: {}, groups: [] },
    { descriptions: [''], confirmations: [], memories: [0], identities: {}, groups: [] },
  ])
    await expect(call.decideRead(['harbor-demo-review', decision, 0])).rejects.toThrow(
      'Invalid review selection.',
    )
  // A ref the proposal does not have passes Desktop's shape check; the engine refuses it.
  await expect(
    call.decideRead([
      'harbor-demo-review',
      { descriptions: ['nobody'], confirmations: [], memories: [0], identities: {}, groups: [] },
      0,
    ]),
  ).rejects.toThrow('Brain description choice is invalid.')
  await expect(
    call.decideRead([
      'harbor-demo-review',
      { descriptions: [], memories: [0], identities: {}, groups: [] },
      0,
    ]),
  ).rejects.toThrow('Brain confirmation choice is invalid.')
})

it('refuses ticking a confirmation that is not held, out of range or twice, as the engine does', async () => {
  const call = createMockBrain(() => 0)
  const proposal = (await call('brain:proposal', ['harbor-demo-review'])) as BrainProposalView
  expect(proposal.confirmations.map((item) => item.claim.hold)).toEqual([null])
  for (const confirmations of [[0], [1], [-1], [0, 0]])
    await expect(
      call.decideRead([
        'harbor-demo-review',
        { descriptions: [], confirmations, memories: [0], identities: {}, groups: [] },
        0,
      ]),
    ).rejects.toThrow('Brain confirmation choice is invalid.')
})

it('gives the harness a required question, held claims and a never-read review', async () => {
  // As the browser harness passes it; the default mock keeps the plain reviews tests rely on.
  const options = { flagAfterMs: 20000, demoReviews: true }
  const call = createMockBrain(() => 0, options)
  const status = (await call('brain:status', [])) as BrainStatus
  const never = status.jobs.filter((job) => brainLaneNeverRead(status.prefs.neverRead, job))
  expect(never.map((job) => job.state)).toEqual(['review'])
  const proposal = (await call('brain:proposal', ['harbor-demo-review'])) as BrainProposalView
  const required = proposal.identities.filter((identity) => identity.required)
  expect(required).toHaveLength(1)
  expect(proposal.memories.flatMap((memory) => memory.hold ?? []).sort()).toEqual([
    'personal',
    'temporary',
  ])
  const ref = required[0]!.ref
  const held = proposal.memories.find((memory) => memory.hold === 'temporary')!
  await call.decideRead([
    'harbor-demo-review',
    {
      descriptions: [ref],
      confirmations: [],
      memories: [0, held.index],
      identities: { [ref]: 'rina' },
      groups: [],
    },
    proposal.revision,
  ])
  const rina = (await call('brain:entity', ['rina'])) as BrainEntityView
  expect(rina.entity.description).toBe(required[0]!.description)
  const tom = (await call('brain:entityMemories', ['tom', {}, null])) as BrainMemoryPage
  expect(tom.memories.map((memory) => memory.summary)).toContain(held.summary)
})

it('enforces never-read argument bounds in the browser mock, too', async () => {
  const call = createMockBrain()
  expect(await call('brain:neverRead', ['harbor-lane', true])).toMatchObject({
    prefs: { neverRead: { sessionIds: ['harbor-lane'] } },
  })
  expect(await call('brain:neverRead', ['harbor-lane', false])).toMatchObject({
    prefs: { neverRead: { sessionIds: [] } },
  })
  for (const args of [
    ['', true],
    ['x'.repeat(201), true],
    ['harbor', 1],
  ])
    await expect(call('brain:neverRead', args)).rejects.toThrow('Invalid Brain never-read lane.')
  await expect(
    call('brain:setPrefs', [
      { ...DEFAULT_BRAIN_PREFS, neverRead: { titles: Array(51).fill('Harbor'), sessionIds: [] } },
    ]),
  ).rejects.toThrow('Invalid Brain never-read settings.')
})

it('does not advance a reader job when a proposal is viewed; status polling advances the mock queue', async () => {
  let now = 0
  const call = createMockBrain(() => now)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  now = 6000
  const queued = (await call('brain:queue', [
    { sessionPath: '/demo/Harbor/passive.jsonl', title: 'Harbor passive read' },
  ])) as BrainStatus
  const id = queued.jobs.at(-1)!.id
  await call('brain:status', [])
  now += 4000
  await expect(call('brain:proposal', [id])).rejects.toThrow('Review not found')
  await call('brain:status', [])
  await expect(call('brain:proposal', [id])).resolves.toMatchObject({ job: { state: 'review' } })
})
