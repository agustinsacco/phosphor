import { expect, it } from 'vitest'
import {
  DEFAULT_BRAIN_PREFS,
  brainLinkSentence,
  type BrainEntityView,
  type BrainExtractionView,
  type BrainGraph,
  type BrainMemoryPage,
  type BrainStatus,
} from '@shared/brain'
import type { BrainRecall, BrainRoutes } from '@shared/brain-recall'
import type { BrainTidyChanges } from '@shared/brain-tidy'
import { createMockBrain } from './mockBrain'
import { MOCK_OWNER_ID, MOCK_SAID_AT } from './mockBrainData'

const LANE = { sessionPath: '/demo/Harbor/lane.jsonl', title: 'Harbor planning' }
type Call = ReturnType<typeof createMockBrain>
const status = async (call: Call) => (await call('brain:status', [])) as BrainStatus

/** Enable Brain, let the model download, then queue one lane and let it save. */
async function readLane(call: Call, clock: { now: number }, lane = LANE): Promise<string> {
  const queued = (await call('brain:queue', [lane])) as BrainStatus
  const id = queued.jobs.at(-1)!.id
  await status(call)
  clock.now += 4000
  await status(call)
  return id
}
async function enabled(options = {}) {
  const clock = { now: MOCK_SAID_AT }
  const call = createMockBrain(() => clock.now, options)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true }])
  clock.now += 6000
  await status(call)
  return { call, clock }
}

it('saves a read when it finishes, journals it with Undo, and Undo leaves it rejected', async () => {
  const { call, clock } = await enabled()
  const before = await status(call)
  const id = await readLane(call, clock)
  const after = await status(call)
  expect(after.counts.memories).toBe(before.counts.memories + 2)
  expect(after.jobs.map((job) => job.id)).not.toContain(id)
  expect(after.readSessionIds).toContain('/demo/Harbor/lane.jsonl')
  const changes = (await call('brain:tidyChanges', [50])) as BrainTidyChanges
  const read = changes.items.find((op) => op.kind === 'read')!
  expect(read).toMatchObject({ who: 'automatic', jobId: id, undoable: true })
  expect(read.summary).toBe('Read Harbor planning: 2 memories')
  const record = (await call('brain:extraction', [id])) as BrainExtractionView
  expect(record.memories).toHaveLength(2)
  expect(await call('brain:laneRead', [record.sessionId])).toMatchObject({
    job: { id, state: 'done' },
    memories: 2,
    replaceable: 2,
  })
  await call('brain:tidyUndo', [read.id, after.revision])
  expect((await status(call)).counts.memories).toBe(before.counts.memories)
  expect(await call('brain:laneRead', [record.sessionId])).toMatchObject({
    job: { id, state: 'rejected', memories: 0 },
  })
  const again = (await call('brain:reread', [id])) as BrainStatus
  expect(again.jobs.at(-1)).toMatchObject({ replaces: id, state: 'queued' })
})

it('replaces the lane’s earlier memories on Read again', async () => {
  const { call, clock } = await enabled()
  const first = await readLane(call, clock)
  const earlier = (await call('brain:extraction', [first])) as BrainExtractionView
  const sessionId = earlier.sessionId
  await call('brain:reread', [first])
  await status(call)
  clock.now += 4000
  await status(call)
  const lane = (await call('brain:laneRead', [sessionId])) as { job: { id: string } }
  expect(lane.job.id).not.toBe(first)
  for (const memory of earlier.memories)
    await expect(call('brain:memory', [memory.id])).rejects.toThrow('Brain memory not found')
})

it('draws the owner’s neighbourhood with sentences, ended links and pairs named together', async () => {
  const call = createMockBrain(() => MOCK_SAID_AT)
  expect((await status(call)).ownerId).toBe(MOCK_OWNER_ID)
  const tom = (await call('brain:neighbourhood', ['tom', 1])) as BrainGraph
  const name = (id: string) => tom.nodes.find((node) => node.id === id)?.label ?? id
  const sentences = tom.links.map((l) => brainLinkSentence(l, name(l.subjectId), name(l.objectId)))
  expect(sentences).toContain(
    'Tom Lee took over Ledger billing from Rina Okafor (since 2026-09-01)',
  )
  expect(tom.ended.map((l) => brainLinkSentence(l, name(l.subjectId), name(l.objectId)))).toEqual([
    'Tom Lee worked on Kestrel (until 2026-08-15)',
  ])
  const view = (await call('brain:entity', ['tom'])) as BrainEntityView
  expect(view.ended.map((c) => c.entity.label)).toEqual(['Kestrel'])
  expect(view.together.map((t) => [t.entity.label, t.shared])).toContainEqual(['Northwind', 2])
  expect(view.groups.flatMap((g) => g.items.map((i) => i.link.label))).toContain('reports to')
})

it('bounds connections, pages memories without repeats and routes in both directions', async () => {
  const call = createMockBrain(() => MOCK_SAID_AT)
  const entity = (await call('brain:entity', ['harbor'])) as BrainEntityView
  const group = entity.groups.find((g) => g.predicate === 'part_of')!
  expect(group.items).toHaveLength(20)
  const first = (await call('brain:entityMemories', ['harbor', {}, null])) as BrainMemoryPage
  const second = (await call('brain:entityMemories', ['harbor', {}, first.next])) as BrainMemoryPage
  expect(new Set([...first.memories, ...second.memories].map((m) => m.id)).size).toBe(
    first.memories.length + second.memories.length,
  )
  const routes = (await call('brain:path', ['mara', 'harbor'])) as BrainRoutes
  expect(routes.routes[0]!.map((step) => step.kind === 'relation' && step.link.predicate)).toEqual([
    'decided',
    'for_customer',
  ])
  const together = (await call('brain:path', ['rina', 'harbor'])) as BrainRoutes
  expect(together.status).toBe('ok')
})

it('answers Ask with hits whose trails start at what the question names', async () => {
  const call = createMockBrain(() => MOCK_SAID_AT)
  const answer = (await call('brain:ask', [
    'Who did Tom take Ledger billing over from?',
  ])) as BrainRecall
  expect(answer).toMatchObject({ mode: 'search', status: 'ok' })
  expect(answer.focus).toContain('tom')
  const handover = answer.hits.find((hit) => hit.memory.id === 'memory-1')!
  expect(handover.trail).toMatchObject({ seedId: expect.any(String), entityId: expect.any(String) })
  const mara = (await call('brain:ask', ['What is Mara busy with?'])) as BrainRecall
  const walked = mara.hits.find((hit) => hit.trail && hit.trail.links.length > 0)!
  expect(walked.trail!.seedId).toBe('mara')
  for (const link of walked.trail!.links)
    expect(mara.entities.map((e) => e.id)).toEqual(
      expect.arrayContaining([link.subjectId, link.objectId]),
    )
  expect(((await call('brain:ask', ['zzzz qqqq'])) as BrainRecall).status).toBe('no_match')
  for (const args of [[''], ['x'.repeat(2001)], [42], ['a', 'b']])
    await expect(call('brain:ask', args)).rejects.toThrow('Invalid Brain request.')
})

it('tells Brain Agent through its lane, says who you are, and bounds both', async () => {
  const off = createMockBrain(() => MOCK_SAID_AT)
  await expect(off('brain:tell', ['Tom Lee left the team'])).rejects.toThrow('Turn Brain on first.')
  const { call } = await enabled()
  expect(await call('brain:tell', ['Tom Lee left the team'])).toEqual({
    sessionPath: '/demo/brain/Brain/brain-agent.jsonl',
  })
  expect(await call('brain:setOwner', ['tom'])).toMatchObject({ ownerId: 'tom' })
  expect(await call('brain:setOwner', [null])).toMatchObject({ ownerId: null })
  await expect(call('brain:setOwner', ['nobody'])).rejects.toThrow('Entity not found')
  for (const args of [[''], [7], []]) {
    await expect(call('brain:tell', args)).rejects.toThrow('Invalid Brain request.')
    await expect(call('brain:laneRead', args)).rejects.toThrow('Invalid Brain request.')
  }
  expect(await call('brain:laneRead', ['never-read-lane'])).toBeNull()
})

it('starts Brain Agent on its own once reads settle after a saved read, unless turned off', async () => {
  const { call, clock } = await enabled({ autoRunMs: 60_000 })
  await readLane(call, clock)
  clock.now += 30_000
  expect((await status(call)).agent.run).toBeNull()
  clock.now += 30_000
  expect((await status(call)).agent.run).toMatchObject({ state: 'queued', automatic: true })
  clock.now += 30_000
  await status(call)
  clock.now += 30_000
  const done = await status(call)
  expect(done.agent.run?.state).toBe('done')
  const changes = (await call('brain:tidyChanges', [50])) as BrainTidyChanges
  expect(changes.items.find((op) => op.kind === 'relate')).toMatchObject({ who: 'agent' })
  const tom = (await call('brain:neighbourhood', ['tom', 1])) as BrainGraph
  expect(tom.links).toContainEqual(
    expect.objectContaining({ objectId: 'northwind', statedBy: 'agent', label: 'works with' }),
  )
  const quiet = await enabled({ autoRunMs: 60_000 })
  await quiet.call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true, agentAuto: false }])
  await readLane(quiet.call, quiet.clock)
  quiet.clock.now += 120_000
  expect((await status(quiet.call)).agent.run).toBeNull()
})

it('retries a failed read, cancels, removes the model only while off, and resets knowledge', async () => {
  const { call, clock } = await enabled()
  const failed = (await status(call)).jobs.find((job) => job.state === 'failed')!
  expect((await call('brain:retry', [failed.id])) as BrainStatus).toMatchObject({
    jobs: expect.arrayContaining([expect.objectContaining({ id: failed.id, state: 'queued' })]),
  })
  await expect(call('brain:removeModel', [])).rejects.toThrow('Turn Brain off')
  const lane = { sessionPath: '/demo/Harbor/cancel.jsonl', title: 'Harbor demo' }
  const queued = (await call('brain:queue', [lane])) as BrainStatus
  await expect(call('brain:queue', [lane])).rejects.toThrow('already queued')
  await call('brain:cancel', [queued.jobs.at(-1)!.id])
  clock.now += 1000
  expect(await call('brain:setPrefs', [DEFAULT_BRAIN_PREFS])).toMatchObject({
    embedding: { phase: 'ready' },
  })
  expect(await call('brain:removeModel', [])).toMatchObject({ embedding: { phase: 'missing' } })
  expect(await call('brain:reset', [])).toMatchObject({
    counts: { memories: 0, entities: 0 },
    ownerId: null,
    prefs: DEFAULT_BRAIN_PREFS,
  })
})

it('refuses to queue or read again a lane Brain never reads, and drops its queued read', async () => {
  const { call, clock } = await enabled()
  const titled = { sessionPath: '/demo/Rina/weekly.jsonl', title: 'Rina Okafor 1:1' }
  await expect(call('brain:queue', [titled])).rejects.toThrow('its title matches a rule')
  const id = await readLane(call, clock)
  await call('brain:queue', [{ sessionPath: '/demo/Harbor/busy.jsonl', title: 'Harbor busy' }])
  await status(call)
  const lane = { sessionPath: '/demo/Harbor/off.jsonl', title: 'Harbor off' }
  const queued = ((await call('brain:queue', [lane])) as BrainStatus).jobs.at(-1)!
  const dropped = (await call('brain:neverRead', [queued.sessionId, true])) as BrainStatus
  expect(dropped.jobs.map((job) => job.id)).not.toContain(queued.id)
  await expect(call('brain:queue', [lane])).rejects.toThrow('Brain is set not to read this lane.')
  await call('brain:neverRead', [LANE.sessionPath, true])
  await expect(call('brain:reread', [id])).rejects.toThrow('Brain is set not to read this lane.')
})

it('carries and freezes the selected reader model in browser mock jobs', async () => {
  const { call, clock } = await enabled()
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true, model: 'harbor/reader' }])
  const queued = (await call('brain:queue', [LANE])) as BrainStatus
  const id = queued.jobs.at(-1)!.id
  await status(call)
  await call('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true, model: 'ledger/reader' }])
  clock.now += 5000
  expect(await call('brain:extraction', [id])).toMatchObject({
    model: 'harbor/reader',
    thinking: 'medium',
  })
})

it('enforces never-read argument bounds in the browser mock, too', async () => {
  const call = createMockBrain()
  expect(await call('brain:neverRead', ['harbor-lane', true])).toMatchObject({
    prefs: { neverRead: { sessionIds: ['harbor-lane'] } },
  })
  for (const args of [
    ['', true],
    ['x'.repeat(201), true],
    ['harbor', 1],
  ])
    await expect(call('brain:neverRead', args)).rejects.toThrow('Invalid Brain never-read lane.')
})

it('gives the harness two saved reads, one about to be read and a failed one', async () => {
  const call = createMockBrain(() => MOCK_SAID_AT, { demo: true })
  const harness = await status(call)
  expect(harness.jobs.map((job) => job.state).sort()).toEqual(['failed', 'queued'])
  const changes = (await call('brain:tidyChanges', [50])) as BrainTidyChanges
  expect(changes.items.filter((op) => op.kind === 'read').map((op) => op.summary)).toEqual([
    'Read Ledger handover: 2 memories',
    'Read Harbor planning: 2 memories',
  ])
})
