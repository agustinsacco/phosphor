import type { BrainAgentMap } from '@phosphor/shared/brain-agent'
import type { BrainCuratorMethod } from '@phosphor/brain-client/validate-curator'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { ExtractionQueue } from '../queue'
import type { BrainSearchPort, BrainServiceOptions } from '../types'
import type { Defrag } from './defrag'

export const BRAIN_OFF = 'Brain is off. The owner can turn it on in Settings › Brain.'

export interface CuratorContext {
  store: BrainStore
  search: BrainSearchPort
  options: BrainServiceOptions
  queue: Pick<ExtractionQueue, 'kick'>
  defrag: Pick<Defrag, 'turnRun'>
  changed(): void
  /** Brain is on, and neither resetting nor shutting down. Lane recall need not be on. */
  enabled(): boolean
}
/** Brain Agent's methods. Every one takes the asking call's signal, aborted when it hangs up. */
export type CuratorApi = {
  [M in BrainCuratorMethod | 'search']: (
    request: BrainAgentMap[M]['request'],
    signal: AbortSignal,
  ) => Promise<BrainAgentMap[M]['result']>
}
