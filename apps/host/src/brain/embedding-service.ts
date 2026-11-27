import { availableParallelism } from 'node:os'
import { createEmbeddingController } from '@phosphor/brain-runtime/embedding/embedding-controller'
import type { BrainEmbeddings } from '@phosphor/brain-runtime/embedding/embedding-port'
import type {
  FromEmbeddingWorker,
  ToEmbeddingWorker,
} from '@phosphor/brain-runtime/embedding/embedding-protocol'
import {
  embeddingPlatformSupported,
  embeddingThreads,
} from '@phosphor/brain-runtime/embedding/model-manifest'
import { forkBrainWorker } from './worker-process'

/** Headroom over the loaded model's JS side; its native tensors live outside this heap. */
const EMBEDDING_HEAP_MB = 1024

/**
 * The Host's local embeddings over `directory` (`<brain>/embeddings`). Nothing here loads the
 * native runtime: only the worker does, after an explicit enable or download, so a missing or
 * broken model cannot affect the Host's lanes.
 */
export function createHostBrainEmbeddings(
  directory: string,
  workerPath: string,
  log: (message: string) => void,
): BrainEmbeddings {
  return createEmbeddingController({
    directory,
    supported: embeddingPlatformSupported(process.platform, process.arch),
    threads: embeddingThreads(availableParallelism()),
    spawn: () =>
      forkBrainWorker<ToEmbeddingWorker, FromEmbeddingWorker>({
        workerPath,
        heapMb: EMBEDDING_HEAP_MB,
        log,
      }),
    log,
  })
}
