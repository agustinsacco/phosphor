import type { MemoryStorePort, MemoryVector } from '@phosphor/memory-engine/ports'
import type { BrainRevision, BrainCapture, BrainEvidence } from '@phosphor/shared/brain'

export type MemoryOperations = MemoryStorePort & {
  captureAt(epoch: number, input: BrainCapture): BrainEvidence | null
  commitVectors(revision: BrainRevision, vectors: MemoryVector[]): boolean
}
export type MemoryRequest = {
  [K in keyof MemoryOperations]: { id: number; method: K; args: Parameters<MemoryOperations[K]> }
}[keyof MemoryOperations]
export type MemoryResponse = { id: number } & (
  { ok: true; data: unknown } | { ok: false; error: string }
)
export const MEMORY_MAX_BYTES = 9_000_000
export const MEMORY_METHODS: readonly (keyof MemoryOperations)[] = [
  'snapshot',
  'setPrefs',
  'capture',
  'read',
  'createJob',
  'claimJob',
  'updateJob',
  'job',
  'submit',
  'review',
  'correct',
  'forget',
  'recordDelivery',
  'graph',
  'search',
  'captureAt',
  'embeddingItems',
  'putVectors',
  'pendingPurges',
  'acknowledgePurge',
  'commitVectors',
  'close',
]
