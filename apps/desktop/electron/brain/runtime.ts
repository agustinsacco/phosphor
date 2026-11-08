import { app } from 'electron'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import type { BrainLearningJobList } from '@phosphor/shared/brain-learning-jobs'
import { registry } from '../registry'
import { desktopSessions, setSessionMemory } from '../pi/session-runtime'
import { sessionPaths } from '../pi/session-path-lock'
import { verifyBrainTools } from '@phosphor/brain-runtime/tool-audit'
import { log } from '../debug-log'
import { createBrainEmbeddings } from './embedding-service'
import { createBrainService, type BrainService } from '@phosphor/brain-runtime/service'
import { createDesktopMemory } from './memory-service'
import { resolveBrainProcessor } from './processor-resolver'
import { createDesktopLearningHost } from './learning-host'

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
/** Metadata checks must not create a database on a fresh profile. Stat errors fail closed. */
async function existingBrainService(): Promise<BrainService | undefined> {
  if (closing) throw new Error('Brain is shutting down')
  if (!pending) {
    const database = await stat(join(app.getPath('userData'), 'brain/memory.sqlite')).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      },
    )
    if (!database) return undefined
    if (!database.isFile()) throw new Error('Brain database is not a regular file')
  }
  return brainService()
}
/** Historical exclusion applies even when capture/recall is now disabled. No public IPC. */
export async function brainSourceExcluded(sessionId: string): Promise<boolean> {
  const service = await existingBrainService()
  if (!service) return false
  const excluded = await service.excludedSource(sessionId)
  if (typeof excluded !== 'boolean') throw new Error('Brain exclusion authority unavailable')
  return excluded
}
/** Shell inventory must not create a database merely because the app started. */
export async function learningInventory(scope?: string): Promise<BrainLearningJobList> {
  const service = await existingBrainService()
  return service
    ? service.api.learningJobs(scope)
    : {
        items: [],
        truncated: false,
        policy: { enabled: false, workspaces: [], policyEpoch: 0 },
      }
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
      openStore: (directory) =>
        createDesktopMemory(directory, join(import.meta.dirname, 'brain-memory-worker.js')),
      resources: { workingExtension: join(resources, 'brain-ext/brain.mjs'), processorExtension },
      learningHost: createDesktopLearningHost({
        directory: join(directory, 'learning'),
        extensionPath: join(resources, 'brain-ext/brain-learning-carrier.mjs'),
      }),
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
