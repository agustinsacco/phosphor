import { app } from 'electron'
import { join } from 'node:path'
import { createBrainService } from '@phosphor/brain-runtime/service'
import type { BrainLanes, BrainService } from '@phosphor/brain-runtime/types'
import { openBrainStore } from '@phosphor/memory-engine/store'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import { registry } from '../registry'
import { log } from '../debug-log'
import { prepareDesktopSessionLaunch } from '../pi/session-launch'
import { desktopSessionPolicy } from '../pi/session-policy'
import { setSessionRecall } from '../pi/session-runtime'
import { createBrainEmbeddings } from './embedding-service'
import { testEmbeddings } from './test-embeddings'

let pending: Promise<BrainService> | undefined
let closing = false

const resources = (): string =>
  app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '../../libs/pi-extensions')

/** A live lane is busy while its agent works; a fork of it waits until it settles. */
const lanes: BrainLanes = {
  busy: (sessionPath) =>
    registry.list().some((live) => {
      const client = registry.get(live.sessionId)?.client
      return client?.sessionFile === sessionPath && client.activity.busy
    }),
  async launch(sessionPath) {
    const launch = await prepareDesktopSessionLaunch()
    const account = await desktopSessionPolicy.account({ sessionPath })
    return {
      binaryPath: launch.binaryPath ?? 'pi',
      prefixArgs: launch.prefixArgs ?? [],
      env: {
        ...launch.env,
        ...(launch.stub ? {} : desktopSessionPolicy.compressionEnvironment()),
        ...account?.env,
      },
    }
  },
}

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
  const root = resources()
  const embeddings =
    testEmbeddings() ??
    createBrainEmbeddings({
      directory: join(directory, 'embeddings'),
      workerPath: join(import.meta.dirname, 'brain-embedding-worker.js'),
    })
  try {
    return await createBrainService({
      directory,
      openStore: (path) => openBrainStore({ path, Database: loadSqlite().DatabaseSync }),
      embeddings,
      lanes,
      guardExtension: join(root, 'brain-ext/brain-fork-guard.mjs'),
      recall: { extension: join(root, 'brain-ext/brain.mjs'), skill: join(root, 'skills/brain') },
      log: (message, data) => log('brain', message, data),
    })
  } catch (error) {
    embeddings.dispose()
    throw error
  }
}

/** Every new lane asks once; Brain off or broken means no recall, never a failed lane. */
export function installBrainRecall(): void {
  setSessionRecall(async () => {
    try {
      return await (await brainService()).recallLaunch()
    } catch (error) {
      log('brain', 'Brain unavailable', { error: String(error) })
      return undefined
    }
  })
}

export async function disposeBrain(): Promise<void> {
  closing = true
  if (pending) await (await pending.catch(() => undefined))?.dispose()
}
