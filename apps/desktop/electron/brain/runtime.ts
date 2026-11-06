import { app } from 'electron'
import { join } from 'node:path'
import { registry } from '../registry'
import { desktopSessions, setSessionMemory } from '../pi/session-runtime'
import { sessionPaths } from '../pi/session-path-lock'
import { verifyBrainTools } from '../pi/brain-tool-audit'
import { log } from '../debug-log'
import { createBrainEmbeddings } from './embedding-service'
import { createBrainService, type BrainService } from './service'
import { resolveBrainProcessor } from './processor-resolver'

let pending: Promise<BrainService> | undefined
let closing = false
const report = (error: unknown): void => log('brain', 'Brain unavailable', { error: String(error) })

/** Lazy, after userData redirection. A failed construction can be retried, not cached forever. */
export function brainService(): Promise<BrainService> {
  if (closing) return Promise.reject(new Error('Brain is shutting down'))
  pending ??= construct().catch((error: unknown) => {
    pending = undefined
    throw error
  })
  return pending
}
async function construct(): Promise<BrainService> {
  const directory = join(app.getPath('userData'), 'brain')
  const resources = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), '../../libs/pi-extensions')
  const processorExtension = join(resources, 'brain-ext/brain-processor.mjs')
  const embeddings = createBrainEmbeddings({
    directory: join(directory, 'embeddings'),
    workerPath: join(import.meta.dirname, 'brain-embedding-worker.js'),
  })
  try {
    return await createBrainService({
      directory,
      embeddings,
      memoryWorkerPath: join(import.meta.dirname, 'brain-memory-worker.js'),
      resources: { workingExtension: join(resources, 'brain-ext/brain.mjs'), processorExtension },
      sessions: desktopSessions,
      registry,
      sessionPaths,
      processor: {
        resolve: resolveBrainProcessor,
        verifyTools: (live) => {
          if (live.owner?.kind !== 'brain') return Promise.reject(new Error('Brain owner required'))
          return verifyBrainTools(
            live.client,
            live.owner.jobId,
            processorExtension,
            AbortSignal.timeout(10_000),
          )
        },
      },
      onError: report,
    })
  } catch (error) {
    embeddings.dispose()
    throw error
  }
}

/** Optional recall must never prevent an ordinary lane from starting. */
export function installBrainMemory(): void {
  setSessionMemory({
    async prepare(options) {
      try {
        return await (await brainService()).memory.prepare(options)
      } catch (error) {
        report(error)
        return undefined
      }
    },
  })
}
export async function disposeBrain(): Promise<void> {
  closing = true
  if (pending) await (await pending).dispose()
}
