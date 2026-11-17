import type { BrainTidyRun } from '@phosphor/shared/brain-tidy'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainSearchPort, BrainServiceOptions } from '../types'
import type { ExtractionQueue } from '../queue'

/** Model-check worker owns this seam and the run lifecycle. */
export interface TidyRunContext {
  store: BrainStore
  search: BrainSearchPort
  options: BrainServiceOptions
  queue: ExtractionQueue
  changed(): void
}
export interface TidyRunner {
  current(): BrainTidyRun | null
  start(): void
  cancel(): void
}
export function createTidyRunner(_context: TidyRunContext): TidyRunner {
  return {
    current: () => null,
    start: () => {
      throw new Error('Brain Tidy is not ready.')
    },
    cancel: () => {},
  }
}
