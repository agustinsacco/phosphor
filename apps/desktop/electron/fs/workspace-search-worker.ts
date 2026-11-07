import { parentPort, workerData } from 'node:worker_threads'
import {
  searchFiles,
  type SearchJob,
  type SearchWorkerMessage,
} from '@phosphor/session-runtime/files/workspace-search'

/**
 * Worker entry for one workspace search (see workspace-search-service.ts).
 * Posts found files batch by batch, then the totals.
 */
const port = parentPort!
const post = (message: SearchWorkerMessage): void => port.postMessage(message)

searchFiles(workerData as SearchJob, (batch) => post({ type: 'batch', ...batch })).then(
  (summary) => post({ type: 'done', summary }),
  (error: unknown) =>
    post({ type: 'failed', error: error instanceof Error ? error.message : String(error) }),
)
