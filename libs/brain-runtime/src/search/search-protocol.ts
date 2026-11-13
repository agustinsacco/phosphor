import type { BrainSearch } from '@phosphor/memory-engine/types'

/** What main may ask the search process. `close` is its own message. */
export const SEARCH_METHODS = [
  'refresh',
  'ready',
  'recall',
  'find',
  'nearestEntities',
  'nearestMemories',
] as const satisfies readonly (keyof BrainSearch)[]
export type SearchMethod = (typeof SEARCH_METHODS)[number]

/** BrainSearch as main sees it: the same methods, answered by another process. */
export type BrainSearchPort = {
  [K in keyof BrainSearch]: (
    ...args: Parameters<BrainSearch[K]>
  ) => Promise<Awaited<ReturnType<BrainSearch[K]>>>
}

export type ToSearchWorker =
  | { type: 'open'; path: string }
  | { type: 'call'; id: number; method: SearchMethod; args: unknown[] }
  | { type: 'close' }

export type FromSearchWorker =
  { type: 'result'; id: number; value: unknown } | { type: 'error'; id: number; error: string }
