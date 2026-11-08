import type { BrainEmbeddingStatus } from '@phosphor/shared/brain'

export interface BrainEmbeddings {
  status(): BrainEmbeddingStatus
  setEnabled(enabled: boolean): Promise<void>
  /** Downloads the pinned model; embed() never downloads. */
  download(): Promise<void>
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
