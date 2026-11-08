import type { BrainEmbeddingStatus } from '@phosphor/shared/brain'

export interface BrainEmbeddings {
  status(): BrainEmbeddingStatus
  setEnabled(enabled: boolean): Promise<void>
  /** Explicit model-terms acknowledgement; downloads never happen during embed(). */
  download(acceptTerms: boolean): Promise<void>
  remove(): Promise<void>
  embed(texts: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<number[][]>
  dispose(): void
}
export interface BrainEmbeddingOptions {
  directory: string
  /** Bundled utility-process entry. No renderer-provided path. */
  workerPath: string
  onStatus?: (status: BrainEmbeddingStatus) => void
}
