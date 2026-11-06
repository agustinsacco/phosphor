import { openMemoryStore } from '@phosphor/memory-engine/service'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import { createMemoryHandler } from './memory-worker-handler'
import type { MemoryRequest } from './memory-protocol'

const port = process.parentPort
if (!port) throw new Error('Brain database requires a utility-process parent')
const directory = process.argv[2]
if (!directory) throw new Error('Brain database requires an owned directory')
const store = openMemoryStore({ directory, Database: loadSqlite().DatabaseSync })
const handle = createMemoryHandler(store)
port.on('message', ({ data }: { data: MemoryRequest }) => port.postMessage(handle(data)))
