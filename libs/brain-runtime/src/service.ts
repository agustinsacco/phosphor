import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { BrainStatus } from '@phosphor/shared/brain'
import { createBrainBridge } from './bridge'
import { createBrainIndexer } from './indexer'
import { createBrainProcessor } from './processor'
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
    revoke: () => bridge.revokeAll(),
    detach: () => working.dispose(),
    stopEmbeddings: () => options.embeddings.dispose(),
    stopIndexing: () => indexer.dispose(),
    stopProcessor: () => processor.dispose(),
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
        'Local Desktop prototype: captures only new plain user entries in lanes started after enrollment. No history, assistant or tool import. Manual processing sends bounded evidence to the explicitly selected native API-key model. Embeddings remain local; no model fallback.',
    }
  }
  async function revoke(): Promise<void> {
    bridge.revokeAll()
    await processor.revoke()
  }
  const api = createBrainApi({
    options,
    store,
    indexer,
    processor,
    transcripts,
    serialize: lifecycle.serialize,
    status,
    revoke,
    isClosed: lifecycle.isClosed,
  })
  let enabled: boolean
  try {
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
  return { api, memory: working.memory, dispose: lifecycle.dispose }
}
