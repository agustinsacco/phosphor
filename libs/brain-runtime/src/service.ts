import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainService, BrainServiceOptions, BrainSearchPort } from './types'
import { ExtractionQueue } from './queue'
import { createAutoRun, type AutoRun } from './agent/auto-run'
import type { BrainAgentRun } from '@phosphor/shared/brain-agent'
import type { ReadOptions } from './extraction-save'
import { extractJob } from './extract'
import { createRecall } from './recall'
import { createApi } from './api'
import { extractionView } from './extraction-view'
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

/** The store and its search index share one database file in the Brain directory. */
async function openBrainFiles(options: BrainServiceOptions) {
  await mkdir(options.directory, { recursive: true })
  await removePrototypeFiles(options.directory)
  const database = join(options.directory, 'brain.sqlite')
  return { store: options.openStore(database), search: options.openSearch(database) }
}

function recoverInterrupted(store: BrainStore): void {
  store.requeueInterrupted()
  store.interruptRuns(DEFRAG_INTERRUPTED)
}

function createQueue(
  store: BrainStore,
  search: BrainSearchPort,
  files: LaneFiles,
  changed: () => void,
  options: ReadOptions,
): ExtractionQueue {
  return new ExtractionQueue({
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
}

export async function createBrainService(options: BrainServiceOptions): Promise<BrainService> {
  const { store, search } = await openBrainFiles(options)
  let disposed = false
  const notify = (): void => {
    if (!disposed) options.onChange?.()
  }
  const maintenance = createTidyMaintenance({ store, search, notify, log: options.log })
  const changed = (): void => {
    notify()
    maintenance.schedule()
    autoRun.changed()
  }
  const files = new LaneFiles()
  const queue = createQueue(store, search, files, changed, {
    ...options,
    onReadSaved: () => autoRun.readSaved(),
  })
  const setup = modelSetup(options, changed, () => queue.kick())
  const defragContext = {
    store,
    search,
    options,
    queue,
    changed,
    runEnded: (run: BrainAgentRun) => autoRun.runEnded(run),
  }
  const defrag = createDefrag(defragContext)
  const autoRun: AutoRun = createAutoRun({ store, queue, defrag, options })
  const curatorContext = {
    store,
    search,
    options,
    queue,
    files,
    defrag,
    changed,
    enabled: () => !disposed && queue.accepting && store.snapshot().prefs.enabled,
  }
  const curator = createCurator(curatorContext)
  const recall = createRecall(store, options, search, () => queue.accepting, store, curator)
  recoverInterrupted(store)
  if (store.snapshot().prefs.enabled) setup.start(() => options.embeddings.setEnabled(true))
  else await options.embeddings.setEnabled(false)
  changed()
  queue.kick()
  const apiContext = {
    store,
    options,
    search,
    queue,
    files,
    changed,
    startModel: setup.start,
    maintenance,
    defrag,
  }
  return {
    api: createApi(apiContext),
    guarded: (beforeMutation) => createApi({ ...apiContext, beforeMutation }),
    job: (id) => store.job(id),
    evidence: (id, canReadSource) => extractionView(store, id, canReadSource),
    agent: (method, request, signal) => recall.agent(method, request, signal),
    forLane: recall.forLane,
    recallLaunch: recall.recallLaunch,
    curatorLaunch: recall.curatorLaunch,
    async dispose() {
      if (disposed) return
      disposed = true
      autoRun.dispose()
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
