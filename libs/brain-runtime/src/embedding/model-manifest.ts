import { BRAIN_EMBEDDING_MODEL } from '@phosphor/shared/brain'
import type { ModelFile } from '@phosphor/session-runtime/model-download'

/**
 * Where Brain's local embedding model comes from, pinned.
 *
 * The identity and consent links are shared with the UI
 * (`BRAIN_EMBEDDING_MODEL`); the files and hashes live only here. This is
 * EmbeddingGemma-300m in the onnx-community ONNX export, q4 weights, at one
 * Hugging Face commit. Only the five files the native runtime reads are
 * fetched, each checked against its exact size and SHA-256 (they match the Hub
 * tree API at this revision). Nothing is bundled and nothing is fetched
 * lazily: files arrive only through the explicit, terms-acknowledged download.
 */
const REVISION = '5090578d9565bb06545b4552f76e6bc2c93e4a66'

function file(path: string, bytes: number, sha256: string): ModelFile {
  return {
    path,
    url: `${BRAIN_EMBEDDING_MODEL.modelUrl}/resolve/${REVISION}/${path}`,
    sha256,
    bytes,
  }
}

export const EMBEDDING_MODEL = {
  id: BRAIN_EMBEDDING_MODEL.id,
  revision: REVISION,
  dimensions: BRAIN_EMBEDDING_MODEL.dimensions,
  /** Directory under `<directory>/embedding-models/`, and the runtime's local model id. */
  directoryName: `embeddinggemma-300m-q4-${REVISION.slice(0, 12)}`,
  dtype: 'q4',
  /** The tokenizer truncates every input to this many tokens. */
  maxTokens: 512,
  /** EmbeddingGemma's prescribed retrieval prompts. */
  prefixes: {
    query: 'task: search result | query: ',
    document: 'title: none | text: ',
  },
  files: [
    file('config.json', 1_765, '6e1f06404b7163e0325ed2ea3e6781cde50f4a50b31780a95ad0d30e8404d77b'),
    file(
      'tokenizer.json',
      20_323_312,
      '4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47',
    ),
    file(
      'tokenizer_config.json',
      1_156_830,
      '3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a',
    ),
    file(
      'onnx/model_q4.onnx',
      519_322,
      'ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043',
    ),
    file(
      'onnx/model_q4.onnx_data',
      196_725_760,
      '599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02',
    ),
  ] as readonly ModelFile[],
} as const

export const EMBEDDING_TOTAL_BYTES = EMBEDDING_MODEL.files.reduce((sum, f) => sum + f.bytes, 0)

/** Texts per worker request; a longer `embed()` call is sent in batches of this size. */
export const EMBEDDING_BATCH_SIZE = 16
/** Texts per `embed()` call. Callers page through more (`embeddingItems(limit)`). */
export const EMBEDDING_MAX_TEXTS = 256
/** Characters kept per text before tokenizing: well past 512 tokens, and bounded. */
export const EMBEDDING_MAX_CHARS = 8_192
/** ORT intra-op threads. Measured: 2 threads match the default within 10%. */
export const EMBEDDING_MAX_THREADS = 4

export function embeddingThreads(cpus: number): number {
  return Math.min(EMBEDDING_MAX_THREADS, Math.max(1, Math.floor(cpus / 2)))
}

/**
 * Where the native runtime has been exercised. `onnxruntime-node` 1.30.0 ships
 * no darwin/x64 binary and the other platforms are untested, so they report
 * `unsupported` rather than falling back to WASM or a cloud service.
 */
export const EMBEDDING_PLATFORMS: readonly string[] = ['darwin-arm64']

export function embeddingPlatformSupported(platform: string, arch: string): boolean {
  return EMBEDDING_PLATFORMS.includes(`${platform}-${arch}`)
}

export type EmbeddingKind = 'query' | 'document'

/** The prompt-prefixed, length-bounded text the model sees. */
export function embeddingInput(text: string, kind: EmbeddingKind): string {
  return EMBEDDING_MODEL.prefixes[kind] + text.slice(0, EMBEDDING_MAX_CHARS)
}
