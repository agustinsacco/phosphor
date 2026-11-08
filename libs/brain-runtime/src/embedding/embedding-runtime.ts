import { sep } from 'node:path'
import { EMBEDDING_MODEL } from './model-manifest'

/**
 * The slice of `@huggingface/transformers` the embedding worker uses. The real
 * module satisfies it structurally; tests substitute a fake.
 */
interface Tensor {
  dims: number[]
  data: ArrayLike<number>
}
type Tokenizer = (
  texts: string[],
  options: { padding: boolean; truncation: boolean; max_length: number },
) => unknown
interface Model {
  (inputs: unknown): Promise<unknown>
  dispose(): Promise<unknown>
}
export interface TransformersModule {
  env: {
    allowRemoteModels: boolean
    allowLocalModels: boolean
    localModelPath: string
    useFSCache: boolean
    useBrowserCache: boolean
    useCustomCache: boolean
    useWasmCache: boolean
    fetch: (input: string | URL, init?: unknown) => Promise<unknown>
  }
  AutoTokenizer: {
    from_pretrained(id: string, options: { local_files_only: boolean }): Promise<Tokenizer>
  }
  AutoModel: {
    from_pretrained(
      id: string,
      options: {
        local_files_only: boolean
        dtype: 'q4'
        device: 'cpu'
        session_options: { intraOpNumThreads: number; interOpNumThreads: number }
      },
    ): Promise<Model>
  }
}

export interface EmbeddingRuntime {
  embed(texts: string[]): Promise<number[][]>
  dispose(): Promise<void>
}

export interface EmbeddingRuntimeConfig {
  modelRoot: string
  modelName: string
  threads: number
}

/**
 * Point Transformers.js at local files and nothing else. Its own
 * `allowRemoteModels=false` already refuses the Hub; replacing `fetch` makes
 * any other attempt (a future default, a WASM CDN path) fail loudly too.
 */
export function configureLocalOnly(tf: TransformersModule, modelRoot: string): void {
  tf.env.allowRemoteModels = false
  tf.env.allowLocalModels = true
  tf.env.localModelPath = modelRoot.endsWith(sep) ? modelRoot : modelRoot + sep
  tf.env.useFSCache = false
  tf.env.useBrowserCache = false
  tf.env.useCustomCache = false
  tf.env.useWasmCache = false
  tf.env.fetch = (input) =>
    Promise.reject(new Error(`Local embeddings never use the network (${String(input)})`))
}

/** L2-normalised rows of a `[n, dimensions]` tensor. */
export function unitRows(tensor: Tensor): number[][] {
  const [rows, width] = tensor.dims
  if (tensor.dims.length !== 2 || width !== EMBEDDING_MODEL.dimensions || rows === undefined) {
    throw new Error(`Unexpected embedding shape [${tensor.dims.join(', ')}]`)
  }
  const out: number[][] = []
  for (let row = 0; row < rows; row++) {
    const values = Array.from({ length: width }, (_, i) => Number(tensor.data[row * width + i]))
    const norm = Math.hypot(...values)
    if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding is not a finite vector')
    out.push(values.map((value) => value / norm))
  }
  return out
}

function sentenceEmbedding(output: unknown): Tensor {
  const tensor = (output as { sentence_embedding?: Tensor } | null)?.sentence_embedding
  if (!tensor) throw new Error('The model returned no sentence_embedding')
  return tensor
}

/** Load the pinned model with the native CPU backend, from local files only. */
export async function loadEmbeddingRuntime(
  config: EmbeddingRuntimeConfig,
  tf: TransformersModule,
): Promise<EmbeddingRuntime> {
  configureLocalOnly(tf, config.modelRoot)
  const tokenizer = await tf.AutoTokenizer.from_pretrained(config.modelName, {
    local_files_only: true,
  })
  const model = await tf.AutoModel.from_pretrained(config.modelName, {
    local_files_only: true,
    dtype: EMBEDDING_MODEL.dtype,
    device: 'cpu',
    session_options: { intraOpNumThreads: config.threads, interOpNumThreads: 1 },
  })
  return {
    async embed(texts) {
      // Synchronous in 4.3.2; awaiting keeps a future async tokenizer correct.
      const inputs: unknown = await tokenizer(texts, {
        padding: true,
        truncation: true,
        max_length: EMBEDDING_MODEL.maxTokens,
      })
      return unitRows(sentenceEmbedding(await model(inputs)))
    },
    async dispose() {
      await model.dispose()
    },
  }
}
