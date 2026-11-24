import type { BrainAgentRun } from '@phosphor/shared/brain-agent'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { Defrag } from './agent/defrag'
import type { ExtractionQueue } from './queue'
import type { BrainServiceOptions } from './types'

export interface AutoRun {
  readSaved(): void
  changed(): void
  runEnded(run: BrainAgentRun): void
  dispose(): void
}
export function createAutoRun(_ctx: {
  store: Pick<BrainStore, 'snapshot' | 'latestRun' | 'waitingCounts' | 'waitingSignature'>
  queue: Pick<ExtractionQueue, 'accepting'>
  defrag: Pick<Defrag, 'start'>
  options: Pick<BrainServiceOptions, 'agent' | 'now' | 'log'>
  delayMs?: number
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
}): AutoRun {
  return { readSaved() {}, changed() {}, runEnded() {}, dispose() {} }
}
