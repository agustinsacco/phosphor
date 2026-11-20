import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Proposal } from '@phosphor/memory-engine/types'
import { createBrainService } from './service'
import { pipelineSetup } from './__fixtures__/pipeline'
import { readLaneEntries } from './transcript'
import type * as Transcript from './transcript'

vi.mock('./transcript', async (importOriginal) => {
  const real = await importOriginal<typeof Transcript>()
  return { ...real, readLaneEntries: vi.fn(real.readLaneEntries) }
})
const reads = vi.mocked(readLaneEntries)
const readsOf = (path: string): number => reads.mock.calls.filter(([p]) => p === path).length
const realSetTimeout = globalThis.setTimeout

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanups.splice(0).reverse()) await close()
  reads.mockClear()
})

async function setup({ busy = false, fakeTimers = false } = {}) {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  s.store.jobs = []
  vi.spyOn(s.options.lanes, 'busy').mockImplementation((path) => busy && path === s.file)
  if (fakeTimers) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  return { ...s, service }
}

/** Waits (in real time) for the queue to finish any lane check, then fires its 2 s timer. */
async function timerKick(): Promise<void> {
  await settle()
  await vi.advanceTimersByTimeAsync(2000)
}
async function settle(): Promise<void> {
  for (let i = 0; i < 400 && vi.getTimerCount() === 0; i++)
    await new Promise((resolve) => realSetTimeout(resolve, 5))
  await Promise.allSettled(reads.mock.results.map((result) => result.value))
}

function staleReview(sessionId: string, jobId: string): Proposal {
  return {
    jobId,
    origin: { sessionId, title: 'Tom sync' },
    scope: '/projects/harbor',
    branch: null,
    computedRevision: 0,
    entities: [],
    memories: [],
    groups: [],
    confirmations: [],
    evidence: [],
    held: 0,
    memoryVectors: [],
    entityVectors: [],
  }
}

it('reads a waiting lane once when queued, and never on 20 s of timer kicks', async () => {
  const s = await setup({ busy: true, fakeTimers: true })
  const queued = await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  expect(queued.jobs[0]?.state).toBe('waiting')
  for (let i = 0; i < 10; i++) await timerKick()
  await settle()
  expect(s.store.jobs[0]?.state).toBe('waiting')
  // The one read is Queue's own validation of the lane.
  expect(readsOf(s.file)).toBe(1)
})

it('remembers six blocked stale reviews: one read each, then only a changed file is read again', async () => {
  const s = await setup({ busy: true, fakeTimers: true })
  s.store.prefs.neverRead = { titles: ['1:1'], sessionIds: [] }
  const lanes = [1, 2, 3, 4, 5, 6].map((week) => ({
    path: join(s.directory, `tom-${week}.jsonl`),
    sessionId: `tom-lane-${week}`,
    name: `Tom Lee 1:1 week ${week}`,
  }))
  for (const lane of lanes) {
    await writeFile(
      lane.path,
      [
        { type: 'session', id: lane.sessionId, cwd: s.directory },
        { type: 'session_info', id: `name-${lane.sessionId}`, name: lane.name },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    )
    const job = s.store.enqueue(
      { ...s.job, sessionId: lane.sessionId, sessionPath: lane.path, title: 'Tom sync' },
      'queued',
    )
    s.store.updateJob(job.id, { state: 'review' })
    s.store.proposals.set(job.id, staleReview(lane.sessionId, job.id))
  }
  s.store.rev = 1
  // A waiting read of another lane keeps the queue's 2 s timer running.
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  const review = () => s.store.jobs.filter((job) => job.sessionId.startsWith('tom-lane-'))
  const perLane = () => lanes.map((lane) => readsOf(lane.path))

  for (let i = 0; i < 10; i++) await timerKick()
  await settle()
  expect(perLane()).toEqual([1, 1, 1, 1, 1, 1])
  expect(review().map((job) => job.state)).toEqual(Array(6).fill('review'))

  s.options.onChange.mockClear()
  await timerKick()
  await timerKick()
  await settle()
  expect(perLane()).toEqual([1, 1, 1, 1, 1, 1])
  expect(s.options.onChange).not.toHaveBeenCalled()

  await appendFile(lanes[2]!.path, '\n' + JSON.stringify({ type: 'custom', id: 'note' }))
  await timerKick()
  await timerKick()
  await settle()
  expect(perLane()).toEqual([1, 1, 2, 1, 1, 1])

  s.store.rev = 2
  await s.service.api.setPrefs({
    ...s.store.prefs,
    neverRead: { titles: ['Tom Lee 1:1'], sessionIds: [] },
  })
  await timerKick()
  await settle()
  expect(perLane()).toEqual([1, 1, 2, 1, 1, 1])
  expect(review().map((job) => job.state)).toEqual(Array(6).fill('review'))
  expect(readsOf(s.file)).toBe(1)
})

it('reads a lane once to start its read, after Queue checks it once', async () => {
  const s = await setup()
  const id = (await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })).jobs[0]!.id
  await vi.waitFor(() => expect(s.store.job(id)?.state).toBe('review'))
  expect(readsOf(s.file)).toBe(2)
})

it('reads a stale review lane at most twice when Brain Agent opens and refreshes it', async () => {
  const s = await setup()
  const id = (await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })).jobs[0]!.id
  await vi.waitFor(() => expect(s.store.job(id)?.state).toBe('review'))
  reads.mockClear()
  s.store.rev++
  await s.service.agent('readReview', { jobId: id })
  expect(s.store.job(id)?.state).toBe('review')
  expect(s.store.storedProposal(id)?.computedRevision).toBe(1)
  expect(readsOf(s.file)).toBeLessThanOrEqual(2)
})

it('re-checks unchanged waiting lanes from their remembered titles when the rules change', async () => {
  const s = await setup({ busy: true })
  vi.mocked(s.options.lanes.busy).mockReturnValue(true)
  const ledger = join(s.directory, 'ledger.jsonl')
  await appendFile(s.file, '\n' + JSON.stringify({ type: 'session_info', name: 'Harbor sync' }))
  await writeFile(
    ledger,
    [
      ...s.entries.map((entry) =>
        entry.type === 'session' ? { ...entry, id: 'ledger-lane' } : entry,
      ),
      { type: 'session_info', name: 'Ledger planning' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor sync' })
  const status = await s.service.api.queue({ sessionPath: ledger, title: 'Ledger planning' })
  expect(status.jobs.map((job) => job.state)).toEqual(['waiting', 'waiting'])
  await s.service.api.setPrefs({
    ...s.store.prefs,
    neverRead: { ...s.store.prefs.neverRead, titles: ['Ledger'] },
  })
  await vi.waitFor(() =>
    expect(s.store.jobs.map((job) => [job.sessionId, job.state])).toEqual([
      ['harbor-lane', 'waiting'],
    ]),
  )
  // Queue's own check of each lane, and nothing since.
  expect([readsOf(s.file), readsOf(ledger)]).toEqual([1, 1])
  expect(s.runner).not.toHaveBeenCalled()
})

it('hands the start check’s read to the run when the lane changed while it waited', async () => {
  const s = await setup({ busy: true })
  const id = (await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })).jobs[0]!.id
  await appendFile(s.file, '\n' + JSON.stringify({ type: 'session_info', name: 'Harbor sync' }))
  vi.mocked(s.options.lanes.busy).mockReturnValue(false)
  await s.service.api.setPrefs(s.store.prefs)
  await vi.waitFor(() => expect(s.store.job(id)?.state).toBe('review'))
  expect(readsOf(s.file)).toBe(2)
})
