import type {
  FromEmbeddingWorker,
  ToEmbeddingWorker,
} from '@phosphor/brain-runtime/embedding/embedding-protocol'
import { createEmbeddingWorkerHandler } from '@phosphor/brain-runtime/embedding/embedding-worker-handler'

/**
 * Entry of the Host's Brain embedding process (`forkBrainWorker`, see embedding-service.ts). Its
 * own process so the model's memory, native runtime and CPU never sit on the Host. Transformers.js
 * is imported only here, and only when a `load` arrives; packaging supplies it beside this entry.
 */
const handle = createEmbeddingWorkerHandler({
  post: (message: FromEmbeddingWorker) => process.send?.(message),
  importTransformers: async () => await import('@huggingface/transformers'),
})

process.on('message', (message: ToEmbeddingWorker) => handle(message))
process.on('disconnect', () => process.exit(0))
