import type { FromEmbeddingWorker, ToEmbeddingWorker } from './embedding-protocol'
import {
  loadEmbeddingRuntime,
  type EmbeddingRuntime,
  type TransformersModule,
} from './embedding-runtime'

export interface EmbeddingWorkerPorts {
  post(message: FromEmbeddingWorker): void
  importTransformers(): Promise<TransformersModule>
}

/**
 * The embedding worker's message loop, without the process around it.
 *
 * Requests run strictly one after another (ORT inference is not
 * interruptible), so a `cancel` can only drop a request that has not started.
 * Every request is answered exactly once, with its own id, unless cancelled.
 */
export function createEmbeddingWorkerHandler(
  ports: EmbeddingWorkerPorts,
): (message: ToEmbeddingWorker) => void {
  let runtime: EmbeddingRuntime | null = null
  let queue = Promise.resolve()
  const cancelled = new Set<number>()

  async function run(message: Exclude<ToEmbeddingWorker, { type: 'cancel' }>): Promise<void> {
    if (message.type === 'load') {
      if (runtime) {
        ports.post({ type: 'error', id: message.id, message: 'The model is already loaded' })
        return
      }
      runtime = await loadEmbeddingRuntime(message, await ports.importTransformers())
      ports.post({ type: 'done', id: message.id })
      return
    }
    if (!runtime) throw new Error('The model is not loaded')
    ports.post({ type: 'vectors', id: message.id, vectors: await runtime.embed(message.texts) })
  }

  return (message) => {
    if (message.type === 'cancel') {
      cancelled.add(message.id)
      return
    }
    queue = queue.then(async () => {
      if (cancelled.delete(message.id)) return
      try {
        await run(message)
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        ports.post({ type: 'error', id: message.id, message: text })
      } finally {
        // A cancel that arrived while this request ran.
        cancelled.delete(message.id)
      }
    })
  }
}
