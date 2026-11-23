import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrainService, BrainServiceOptions } from './types'
import { ExtractionQueue } from './queue'
import { extractJob } from './extract'
import { createRecall } from './recall'
import { createApi } from './api'
import { createTidyMaintenance } from './tidy/maintenance'
import { currentReadCheck } from './lane-read-rules'
import { LaneFiles } from './lane-files'

/** Setup runs in the background: saving a preference must not wait for a model download. */
function modelSetup(options: BrainServiceOptions, changed: () => void, kick: () => void) {
  const pending = new Set<Promise<void>>()
  function start(run: () => Promise<void>): void {
    const done = run()
      .catch((error: unknown) => {
        options.log?.('Brain model setup failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      })
      .finally(() => {
        pending.delete(done)
        changed()
        kick()
      })
    pending.add(done)
    changed()
  }
  return {
    start,
    async settled() {
      await Promise.all(pending)
    },
  }
}

/** What the default-off prototype wrote. This schema cannot read it, so nothing could show or delete it. */
const PROTOTYPE_FILES = [
  'memory.sqlite',
  'memory.sqlite-wal',
  'memory.sqlite-shm',
  'evidence',
  'learning',
  'sessions',
]

export async function createBrainService(options: BrainServiceOptions): Promise<BrainService> {
  await mkdir(options.directory, { recursive: true })
  await Promise.all(
    PROTOTYPE_FILES.map((name) =>
      rm(join(options.directory, name), { recursive: true, force: true }),
    ),
  )
  const store = options.openStore(join(options.directory, 'brain.sqlite'))
  const search = options.openSearch(join(options.directory, 'brain.sqlite'))
  let disposed = false
  const notify = (): void => {
    if (!disposed) options.onChange?.()
  }
  const maintenance = createTidyMaintenance({ store, search, notify, log: options.log })
  const changed = (): void => {
    notify()
    maintenance.schedule()
  }
  const files = new LaneFiles()
  const queue = new ExtractionQueue({
    store,
    busy: (path) => options.lanes.busy(path),
    ready: () => store.snapshot().prefs.enabled && options.embeddings.status().phase === 'ready',
    run: (job, signal, entries) => extractJob(job, signal, store, options, search, entries),
    changed,
    check: (job) => currentReadCheck(store, files, job),
    cancelled: (job, reason) =>
      options.log?.('Brain job cancelled', {
        jobId: job.id,
        model: job.model,
        phase: job.state,
        ...(reason ? { reason } : {}),
      }),
    now: options.now ?? Date.now,
  })
  const recall = createRecall(store, options, search, () => queue.accepting, store)
  const setup = modelSetup(options, changed, () => queue.kick())
  store.requeueInterrupted()
  if (store.snapshot().prefs.enabled) setup.start(() => options.embeddings.setEnabled(true))
  else await options.embeddings.setEnabled(false)
  changed()
  queue.kick()
  return {
    api: createApi({
      store,
      options,
      search,
      queue,
      files,
      changed,
      startModel: setup.start,
      maintenance,
    }),
    agent: recall.agent,
    forLane: recall.forLane,
    recallLaunch: recall.recallLaunch,
    async dispose() {
      if (disposed) return
      disposed = true
      options.embeddings.dispose()
      await queue.dispose()
      await maintenance.stop()
      await setup.settled()
      await recall.dispose()
      await search.close()
      store.close()
    },
  }
}
