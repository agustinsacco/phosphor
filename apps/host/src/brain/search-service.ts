import { createSearchClient } from '@phosphor/brain-runtime/search/search-client'
import type {
  FromSearchWorker,
  ToSearchWorker,
} from '@phosphor/brain-runtime/search/search-protocol'
import type { BrainSearchPort } from '@phosphor/brain-runtime/types'
import { forkBrainWorker } from './worker-process'

/** The vector index for a large Brain fits well inside this; a runaway scan does not. */
const SEARCH_HEAP_MB = 1024

/** Brain search over `path`, read-only, in a Node process that starts on the first search. */
export function createHostBrainSearch(
  path: string,
  workerPath: string,
  log: (message: string) => void,
): BrainSearchPort {
  return createSearchClient({
    path,
    spawn: () =>
      forkBrainWorker<ToSearchWorker, FromSearchWorker>({
        workerPath,
        heapMb: SEARCH_HEAP_MB,
        log,
      }),
    log,
  })
}
