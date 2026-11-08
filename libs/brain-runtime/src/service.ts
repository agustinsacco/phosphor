import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { BrainStatus } from '@phosphor/shared/brain'
import { createBrainBridge } from './bridge'
import { createBrainIndexer } from './indexer'
import { createBrainProcessor } from './processor'
import { createBrainLearning } from './learning-coordinator'
import { createBrainWorking } from './working'
import { createBrainTranscripts } from './transcripts'
import { createBrainLifecycle } from './service-lifecycle'
import { createBrainApi } from './controller'
import type { BrainService, BrainServiceOptions } from './service-types'
import type { BrainMemoryClient } from './memory-client'
export type { BrainService, BrainServiceOptions, BrainApi } from './service-types'

/** Node backend. No startup downloads, ambient auth, or alternative session spawner. */
export async function createBrainService(options: BrainServiceOptions): Promise<BrainService> {
  for (const path of [options.directory, ...Object.values(options.resources)])
    if (!isAbsolute(path)) throw new Error('Brain requires absolute owned resource paths')
  await mkdir(options.directory, { recursive: true, mode: 0o700 })
  const store = options.openStore(options.directory)
  try {
    return await assembleBrainService(options, store)
  } catch (error) {
    await store.close().catch((failure: unknown) => options.onError?.(failure))
    throw error
  }
}

/** Injectable worker port for focused integration tests; never exposed through IPC. */
export async function assembleBrainService(
  options: BrainServiceOptions,
  store: BrainMemoryClient,
): Promise<BrainService> {
  const sessionDir = join(await realpath(options.directory), 'sessions')
  await mkdir(sessionDir, { recursive: true, mode: 0o700 })
  const indexer = createBrainIndexer(store, options.embeddings)
  const learning = options.learningHost
    ? createBrainLearning({ store, host: options.learningHost, report: options.onError })
    : undefined
  const bridge = await createBrainBridge({
    async allowed(capability) {
      try {
        if (capability.kind === 'processor') await processor.authorized(capability)
        else await working.authority(capability)
        return true
      } catch {
        return false
      }
    },
    invoke(capability, method, params) {
      return capability.kind === 'processor'
        ? processor.invoke(capability, method, params)
        : working.invoke(capability, method, params)
    },
  })
  const processor = createBrainProcessor(options, store, bridge, sessionDir)
  const working = createBrainWorking(options, store, bridge, indexer)
  const transcripts = createBrainTranscripts(options, store, sessionDir, processor.cancel)
  const lifecycle = createBrainLifecycle({
    revoke: () => {
      bridge.revokeAll()
      learning?.abort()
    },
    detach: () => working.dispose(),
    stopEmbeddings: () => options.embeddings.dispose(),
    stopIndexing: () => indexer.dispose(),
    stopProcessor: async () => {
      try {
        await learning?.dispose()
      } finally {
        await processor.dispose()
      }
    },
    purge: () => transcripts.purge(),
    closeBridge: () => bridge.close(),
    closeStore: () => store.close(),
  })
  async function status(): Promise<BrainStatus> {
    if (lifecycle.isClosed()) throw new Error('Brain is disposed')
    await transcripts.purge()
    return {
      supported: true,
      snapshot: await store.snapshot(),
      embedding: options.embeddings.status(),
      notice:
        'Local Desktop prototype. Automatic capture is limited to admitted new user text. Explicit lane learning preserves pi-projected history and requires a qualified source-model/account binding, one private response and manual review. Cache reuse is best effort. The separate evidence processor still requires a selected native API-key model. Embeddings remain local; no model fallback.',
    }
  }
  async function revoke(): Promise<void> {
    bridge.revokeAll()
    await learning?.revoke()
    await processor.revoke()
  }
  const api = createBrainApi({
    options,
    store,
    indexer,
    processor,
    learning,
    transcripts,
    serialize: lifecycle.serialize,
    status,
    revoke,
    isClosed: lifecycle.isClosed,
  })
  await initializeBrain(options, store, indexer, lifecycle)
  // Move holds a source path: never queue this read behind path-taking preflight work.
  const excludedSource = async (id: string): Promise<boolean> => {
    if (lifecycle.isClosed()) throw new Error('Brain is disposed')
    const excluded = await store.excludedSource(id)
    if (lifecycle.isClosed()) throw new Error('Brain is disposed')
    return excluded
  }
  return { api, memory: working.memory, excludedSource, dispose: lifecycle.dispose }
}
/** Optional derived indexes fail open; authoritative startup failures still dispose owners. */
async function initializeBrain(
  options: BrainServiceOptions,
  store: BrainMemoryClient,
  indexer: ReturnType<typeof createBrainIndexer>,
  lifecycle: ReturnType<typeof createBrainLifecycle>,
): Promise<void> {
  let enabled: boolean
  try {
    await options.learningHost?.recover?.()
    enabled = (await store.snapshot()).prefs.enabled
  } catch (error) {
    await lifecycle.dispose().catch((failure: unknown) => options.onError?.(failure))
    throw error
  }
  try {
    await options.embeddings.setEnabled(enabled)
    await indexer.index()
  } catch (error) {
    options.onError?.(error)
  }
}
