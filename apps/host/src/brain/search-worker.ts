import { openBrainSearch } from '@phosphor/memory-engine/search'
import type { ToSearchWorker } from '@phosphor/brain-runtime/search/search-protocol'
import { createSearchWorkerHandler } from '@phosphor/brain-runtime/search/search-worker-handler'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'

/**
 * Entry of the Host's Brain search process (`forkBrainWorker`, see search-service.ts): its own
 * read-only SQLite connection and in-memory vector index, so scans and graph walks never block
 * the Host or its writer. It exits with the Host's channel.
 */
const handle = createSearchWorkerHandler({
  post: (message) => process.send?.(message),
  open: (path) => openBrainSearch({ path, Database: loadSqlite().DatabaseSync }),
})

process.on('message', (message: ToSearchWorker) => handle(message))
process.on('disconnect', () => process.exit(0))
