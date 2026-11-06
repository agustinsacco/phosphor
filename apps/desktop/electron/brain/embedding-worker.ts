import type {
  FromEmbeddingWorker,
  ToEmbeddingWorker,
} from '@phosphor/brain-runtime/embedding/embedding-protocol'
import { createEmbeddingWorkerHandler } from '@phosphor/brain-runtime/embedding/embedding-worker-handler'

/**
 * Entry of the Brain embedding utility process (`utilityProcess.fork`, see
 * embedding-service.ts). Its own process so the model's ~600 MB, its native
 * runtime and its CPU never sit on main, and a crash takes nothing else down.
 * Transformers.js (and with it onnxruntime-node and sharp) is imported only
 * here, and only when a `load` arrives.
 */
const handle = createEmbeddingWorkerHandler({
  post: (message: FromEmbeddingWorker) => process.parentPort.postMessage(message),
  importTransformers: async () => await import('@huggingface/transformers'),
})

process.parentPort.on('message', ({ data }: { data: ToEmbeddingWorker }) => handle(data))
