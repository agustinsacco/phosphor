import { app } from 'electron'
import { BRAIN_EMBEDDING_MODEL, type BrainEmbeddingStatus } from '@phosphor/shared/brain'
import type { BrainEmbeddings } from '@phosphor/brain-runtime/embedding/embedding-port'

/**
 * E2E hook: PHOSPHOR_BRAIN_TEST_EMBEDDINGS replaces the 208 MB model with word-hash
 * vectors, so the suite can queue, review and search without a download. Gated on
 * `!app.isPackaged`, like every other e2e hook.
 */
export function testEmbeddings(): BrainEmbeddings | undefined {
  if (app.isPackaged || !process.env.PHOSPHOR_BRAIN_TEST_EMBEDDINGS) return undefined
  let phase: BrainEmbeddingStatus['phase'] = 'missing'
  const total = BRAIN_EMBEDDING_MODEL.downloadBytes
  return {
    status: () => ({
      phase,
      receivedBytes: phase === 'ready' ? total : 0,
      totalBytes: total,
      modelId: BRAIN_EMBEDDING_MODEL.id,
      dimensions: BRAIN_EMBEDDING_MODEL.dimensions,
    }),
    setEnabled: async (enabled) => {
      if (enabled) phase = 'ready'
    },
    download: async () => {
      phase = 'ready'
    },
    remove: async () => {
      phase = 'missing'
    },
    embed: async (texts) => texts.map(wordVector),
    dispose: () => {},
  }
}

function wordVector(text: string): number[] {
  const vector = new Array<number>(BRAIN_EMBEDDING_MODEL.dimensions).fill(0)
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let hash = 0
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    vector[hash % vector.length]! += 1
  }
  const norm = Math.hypot(...vector) || 1
  return vector.map((value) => value / norm)
}
