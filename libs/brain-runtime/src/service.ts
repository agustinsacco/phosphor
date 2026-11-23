import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainService, BrainServiceOptions } from './types'
import { ExtractionQueue } from './queue'
import { returnRefreshesToReview } from './stale-review'
import { extractJob } from './extract'
import { createRecall } from './recall'
import { createApi } from './api'
import { createTidyMaintenance } from './tidy/maintenance'
import { currentReadCheck } from './lane-read-rules'
import { LaneFiles } from './lane-files'
import { createDefrag, DEFRAG_INTERRUPTED } from './agent/defrag'
import { createCurator } from './agent/curator'

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

async function removePrototypeFiles(directory: string): Promise<void> {
  await Promise.all(
    PROTOTYPE_FILES.map((name) => rm(join(directory, name), { recursive: true, force: true })),
  )
}

/**
 * What the last session left: reads go back to the queue, refreshes nobody waits for any more go
 * back to review (stale reviews wait for Brain Agent), and an unfinished Defrag run is reported.
 */
function recoverInterrupted(store: BrainStore, options: BrainServiceOptions): void {
  store.requeueInterrupted()
  const left = returnRefreshesToReview(store)
  if (left) options.log?.('Brain left stale reviews waiting for Brain Agent', { reviews: left })
  store.interruptRuns(DEFRAG_INTERRUPTED)
}

export async function createBrainService(options: BrainServiceOptions): Promise<BrainService> {
  await mkdir(options.directory, { recursive: true })
  await removePrototypeFiles(options.directory)
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
    check: (job) => currentReadCheck(store, files, job, options.agent?.folder),
    cancelled: (job, reason) =>
      options.log?.('Brain job cancelled', {
        jobId: job.id,
        model: job.model,
        phase: job.state,
        ...(reason ? { reason } : {}),
      }),
    now: options.now ?? Date.now,
  })
  const setup = modelSetup(options, changed, () => queue.kick())
  const defrag = createDefrag({ store, search, options, queue, changed })
  const curator = createCurator({
    store,
    search,
    options,
    queue,
    files,
    defrag,
    changed,
    enabled: () => !disposed && queue.accepting && store.snapshot().prefs.enabled,
  })
  const recall = createRecall(store, options, search, () => queue.accepting, store, curator)
  recoverInterrupted(store, options)
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
      defrag,
    }),
    agent: (method, request, signal) => recall.agent(method, request, signal),
    forLane: recall.forLane,
    recallLaunch: recall.recallLaunch,
    curatorLaunch: recall.curatorLaunch,
    async dispose() {
      if (disposed) return
      disposed = true
      defrag.dispose()
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
