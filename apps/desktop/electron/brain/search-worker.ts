import { openBrainSearch } from '@phosphor/memory-engine/search'
import type { ToSearchWorker } from '@phosphor/brain-runtime/search/search-protocol'
import { createSearchWorkerHandler } from '@phosphor/brain-runtime/search/search-worker-handler'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'

/**
 * Entry of the Brain search utility process (`utilityProcess.fork`, see search-service.ts). It
 * holds its own read-only SQLite connection and the in-memory vector index, so scans, graph walks
 * and the first index load never block main or the writer.
 */
const handle = createSearchWorkerHandler({
  post: (message) => process.parentPort.postMessage(message),
  open: (path) => openBrainSearch({ path, Database: loadSqlite().DatabaseSync }),
})

process.parentPort.on('message', ({ data }: { data: ToSearchWorker }) => handle(data))
