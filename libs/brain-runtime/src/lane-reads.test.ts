import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
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

it('reads a lane once to start its read, after Queue checks it once', async () => {
  const s = await setup()
  const id = (await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })).jobs[0]!.id
  await vi.waitFor(() => expect(s.store.job(id)?.state).toBe('done'))
  expect(readsOf(s.file)).toBe(2)
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
  await vi.waitFor(() => expect(s.store.job(id)?.state).toBe('done'))
  expect(readsOf(s.file)).toBe(2)
})
