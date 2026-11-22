import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrainJob } from '@phosphor/shared/brain'
import type { Proposal } from '@phosphor/memory-engine/types'
import { ExtractionQueue } from '../queue'
import { LaneFiles } from '../lane-files'
import { currentReadCheck, DELETED_LANE_REFRESH_REFUSAL } from '../lane-read-rules'
import { FakeAgentStore } from '../__fixtures__/fake-agent-store'
import { HARBOR_JOB } from '../__fixtures__/fake-store'
import { freshReview, READ_STILL_REFRESHING, type ReviewRefreshContext } from './review-refresh'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

/** Reviews read at knowledge revision 0. `stale()` changes Brain, as an approval does. */
/** One read waiting in review per lane, each with a transcript on disk. */
async function seedReviews(lanes: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'brain-refresh-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const store = new FakeAgentStore()
  store.prefs.enabled = true
  const jobs: BrainJob[] = []
  for (const lane of lanes) {
    const file = join(directory, `${lane}.jsonl`)
    await writeFile(file, JSON.stringify({ type: 'session', id: lane, cwd: directory }))
    const job = store.enqueue({ ...HARBOR_JOB, sessionId: lane, sessionPath: file }, 'queued')
    store.updateJob(job.id, { state: 'review' })
    store.proposals.set(job.id, { jobId: job.id, computedRevision: 0 } as Proposal)
    jobs.push(store.job(job.id)!)
  }
  return { store, jobs }
}

/** The reader: refreshes a review at the current revision, or holds until released. */
function reader(store: FakeAgentStore) {
  let running = 0
  let peak = 0
  const gates: (() => void)[] = []
  const held = { on: false, ignoringAbort: false }
  const states: string[] = []
  const run = vi.fn(async (job: BrainJob, signal: AbortSignal) => {
    states.push(job.state)
    peak = Math.max(peak, ++running)
    try {
      if (held.on)
        await new Promise<void>((resolve, reject) => {
          gates.push(resolve)
          // A model call can ignore abort while it cleans up.
          if (!held.ignoringAbort)
            signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      signal.throwIfAborted()
      store.proposals.set(job.id, {
        jobId: job.id,
        computedRevision: store.knowledgeRevision(),
      } as Proposal)
      store.updateJob(job.id, { state: 'review', runStartedAt: null })
    } finally {
      running--
    }
  })
  const release = () => gates.splice(0).forEach((open) => open())
  return { run, states, held, release, peak: () => peak }
}

async function setup(lanes = ['harbor']) {
  const { store, jobs } = await seedReviews(lanes)
  const { run, states, held, release, peak } = reader(store)
  const files = new LaneFiles()
  let ready = true
  const queue = new ExtractionQueue({
    store,
    busy: () => false,
    ready: () => ready,
    run,
    changed: () => {},
    check: (job) => currentReadCheck(store, files, job),
    now: () => 123,
  })
  cleanups.push(() => queue.dispose())
  // Runs first: a held run never keeps the queue from closing.
  cleanups.push(async () => {
    held.on = false
    release()
  })
  let task: AbortSignal | null = null
  const context: ReviewRefreshContext = {
    store,
    files,
    queue,
    defragTurnSignal: () => task,
    waitMs: 2000,
    pollMs: 5,
  }
  return {
    store,
    jobs,
    queue,
    run,
    states,
    context,
    stale: () => {
      store.rev++
    },
    peak,
    holdRuns: (ignoreAbort = false) =>
      Object.assign(held, { on: true, ignoringAbort: ignoreAbort }),
    release,
    setReady: (value: boolean) => (ready = value),
    /** Runs `inside` as the active Defrag task. */
    defrag: (inside: (signal: AbortSignal) => Promise<void>) =>
      queue.enqueueTask(async (signal) => {
        task = signal
        try {
          await inside(signal)
        } finally {
          task = null
        }
      }),
  }
}
const call = () => new AbortController().signal

it('outside a run, waits for the queue to refresh a stale review, then returns it', async () => {
  const s = await setup()
  const id = s.jobs[0]!.id
  s.stale()
  await expect(freshReview(s.context, id, call())).resolves.toBeNull()
  expect(s.run).toHaveBeenCalledOnce()
  expect(s.states).toEqual(['refreshing'])
  expect(s.store.job(id)?.state).toBe('review')
  expect(s.store.storedProposal(id)?.computedRevision).toBe(1)
  // Fresh now: nothing runs again.
  await expect(freshReview(s.context, id, call())).resolves.toBeNull()
  expect(s.run).toHaveBeenCalledOnce()
})

it('outside a run, refuses with a sentence when the refresh does not finish in time', async () => {
  const s = await setup()
  s.setReady(false)
  s.stale()
  s.context.waitMs = 30
  await expect(freshReview(s.context, s.jobs[0]!.id, call())).rejects.toThrow(READ_STILL_REFRESHING)
  expect(s.store.job(s.jobs[0]!.id)?.state).toBe('refreshing')
  expect(s.run).not.toHaveBeenCalled()
})

it('outside a run, the wait stops when the caller hangs up', async () => {
  const s = await setup()
  s.setReady(false)
  s.stale()
  const hangUp = new AbortController()
  const waiting = freshReview(s.context, s.jobs[0]!.id, hangUp.signal)
  hangUp.abort()
  await expect(waiting).rejects.toThrow()
})

it('inside a run, Defrag refreshes the review itself, one at a time, never two model runs', async () => {
  const s = await setup(['harbor', 'ledger', 'kestrel'])
  const results: (string | null)[] = []
  const task = s.defrag(async () => {
    // Brain Agent approved something: every review went stale while Defrag holds the worker.
    s.stale()
    s.queue.kick()
    results.push(
      ...(await Promise.all(s.jobs.map((job) => freshReview(s.context, job.id, call())))),
    )
  })
  await task.done
  expect(results).toEqual([null, null, null])
  expect(s.run).toHaveBeenCalledTimes(3)
  expect(s.peak()).toBe(1)
  for (const job of s.jobs) expect(s.store.storedProposal(job.id)?.computedRevision).toBe(1)
})

it('the queue never refreshes a stale review on its own, inside a run or after it', async () => {
  const s = await setup()
  const id = s.jobs[0]!.id
  let inside: (() => void) | undefined
  const task = s.defrag(() => new Promise<void>((resolve) => (inside = resolve)))
  await vi.waitFor(() => expect(inside).toBeDefined())
  s.stale()
  s.queue.kick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(s.run).not.toHaveBeenCalled()
  expect(s.store.job(id)?.state).toBe('review')
  inside!()
  await task.done
  // After Defrag lets go it still waits, stale, until Brain Agent opens it.
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(s.run).not.toHaveBeenCalled()
  expect(s.store.job(id)?.state).toBe('review')
  await expect(freshReview(s.context, id, call())).resolves.toBeNull()
  expect(s.run).toHaveBeenCalledOnce()
  expect(s.store.storedProposal(id)?.computedRevision).toBe(1)
})

it('Stop mid-refresh aborts the run, puts the read back in review, and records no failure', async () => {
  const s = await setup()
  const id = s.jobs[0]!.id
  s.holdRuns()
  let refreshed: Promise<string | null> | undefined
  const task = s.defrag(async () => {
    s.stale()
    refreshed = freshReview(s.context, id, call())
    await refreshed
  })
  await vi.waitFor(() => expect(s.run).toHaveBeenCalledOnce())
  expect(s.store.job(id)).toMatchObject({ state: 'refreshing', runStartedAt: 123 })
  task.cancel()
  await expect(refreshed).rejects.toThrow()
  await task.done.catch(() => undefined)
  // Stale, it waits for Brain Agent to open it again; nothing refreshes it meanwhile.
  expect(s.store.job(id)).toMatchObject({ state: 'review', error: null, runStartedAt: null })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(s.run).toHaveBeenCalledOnce()
  expect(s.peak()).toBe(1)
})

it('returns the refusal for a lane Brain may not read again, without refreshing', async () => {
  const s = await setup(['harbor', 'ledger'])
  await s.queue.pause()
  s.stale()
  s.store.prefs.neverRead = { ...s.store.prefs.neverRead, sessionIds: ['harbor'] }
  await expect(freshReview(s.context, s.jobs[0]!.id, call())).resolves.toBe(
    'Brain is set not to read this lane.',
  )
  await unlink(s.jobs[1]!.sessionPath)
  await expect(freshReview(s.context, s.jobs[1]!.id, call())).resolves.toBe(
    DELETED_LANE_REFRESH_REFUSAL,
  )
  expect(s.run).not.toHaveBeenCalled()
})

/** A Defrag task whose turn ends when Stop aborts it, while an inline refresh it started runs. */
function stoppableRefresh(s: Awaited<ReturnType<typeof setup>>, id: string) {
  let refreshed: Promise<string | null> | undefined
  const task = s.defrag(async (signal) => {
    s.stale()
    refreshed = freshReview(s.context, id, call())
    refreshed.catch(() => undefined)
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
  })
  return { task, refreshed: () => refreshed! }
}

it('Stop keeps the worker until the inline refresh settles: never two runs on one job', async () => {
  const s = await setup()
  const id = s.jobs[0]!.id
  s.holdRuns(true)
  const { task, refreshed } = stoppableRefresh(s, id)
  await vi.waitFor(() => expect(s.run).toHaveBeenCalledOnce())
  task.cancel()
  await task.done
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(s.run).toHaveBeenCalledOnce()
  expect(s.queue.defragActive).toBe(true)
  s.release()
  await expect(refreshed()).rejects.toThrow()
  await vi.waitFor(() => expect(s.queue.defragActive).toBe(false))
  expect(s.peak()).toBe(1)
})

it('pause and dispose wait for an inline refresh to settle', async () => {
  for (const end of ['pause', 'dispose'] as const) {
    const s = await setup()
    s.holdRuns(true)
    const { refreshed } = stoppableRefresh(s, s.jobs[0]!.id)
    await vi.waitFor(() => expect(s.run).toHaveBeenCalledOnce())
    let ended = false
    const ending = s.queue[end]().then(() => (ended = true))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(ended).toBe(false)
    s.release()
    await ending
    await expect(refreshed()).rejects.toThrow()
    expect(s.peak()).toBe(1)
  }
})
