import { app } from 'electron'
import { join } from 'node:path'
import { createBrainService } from '@phosphor/brain-runtime/service'
import type { BrainLanes, BrainService } from '@phosphor/brain-runtime/types'
import { openBrainStore } from '@phosphor/memory-engine/store'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { desktopBrainApp } from './app-service'
import { localRuntimeMode } from '../local-machine/mode'
import { registry } from '../registry'
import { log } from '../debug-log'
import { broadcast } from '../broadcast'
import { prepareDesktopSessionLaunch } from '../pi/session-launch'
import { desktopSessionPolicy } from '../pi/session-policy'
import { setSessionRecall } from '../pi/contributions/brain'
import { desktopSessions, spawnSession } from '../pi/session-runtime'
import { createBrainAgentLane } from './agent-lane'
import { brainLaneFolder, laneBrainLaunch } from './lane-folder'
import { createBrainEmbeddings } from './embedding-service'
import { createDesktopSearch } from './search-service'
import { testEmbeddings } from './test-embeddings'

let pending: Promise<BrainService> | undefined
let closing = false

const resources = (): string =>
  app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '../../libs/pi-extensions')

/** A live lane is busy while its agent works; its extraction waits until it settles. */
const lanes: BrainLanes = {
  busy: (sessionPath) =>
    localRuntimeMode() === 'daemon'
      ? desktopBrainApp.busy(sessionPath)
      : registry.list().some((live) => {
          const client = registry.get(live.sessionId)?.client
          return client?.sessionFile === sessionPath && client.activity.busy
        }),
  async launch(sessionPath) {
    const launch = await prepareDesktopSessionLaunch()
    const account = await desktopSessionPolicy.account({ sessionPath })
    return {
      binaryPath: launch.binaryPath ?? 'pi',
      prefixArgs: launch.prefixArgs ?? [],
      // No context-compression environment: quotes must match the lane's own text.
      env: { ...launch.env, ...account?.env },
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

/** Brain Agent's turns run in the Brain lane like any lane the owner opens. */
const agentLane = (folder: string) =>
  createBrainAgentLane({
    folder,
    transcripts: (cwd) => sessionDirForCwd(cwd),
    create: (options, execution) => spawnSession(options, undefined, execution),
    client: (sessionId) => registry.get(sessionId)?.client,
    command: (sessionId, command) => desktopSessions.command(sessionId, command),
    // In daemon mode no window lists the in-app Brain lane's folder.
    changed: (workspacePath) => {
      if (localRuntimeMode() !== 'daemon') broadcast('sessions:changed', { workspacePath })
    },
  })

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
      openSearch: (path) =>
        createDesktopSearch(path, join(import.meta.dirname, 'brain-search-worker.js')),
      embeddings,
      lanes,
      onChange: () => desktopBrainApp.brainChanged(),
      guardExtension: join(root, 'brain-ext/brain-fork-guard.mjs'),
      recall: { extension: join(root, 'brain-ext/brain.mjs'), skill: join(root, 'skills/brain') },
      curator: {
        extension: join(root, 'brain-ext/brain-curator.mjs'),
        skill: join(root, 'skills/brain-agent'),
      },
      agent: agentLane(brainLaneFolder(app.getPath('userData'))),
      log: (message, data) => log('brain', message, data),
    })
  } catch (error) {
    embeddings.dispose()
    throw error
  }
}

/**
 * Every new lane asks once; Brain off or broken means no recall, never a failed lane. The Brain
 * lane gets Brain Agent's tools instead, and its default rules if AGENTS.md is missing.
 */
export function installBrainRecall(): void {
  desktopBrainApp.install(brainService, () => log('brain', 'Brain app service unavailable'))
  setSessionRecall(async (workspacePath) => {
    try {
      const folder = brainLaneFolder(app.getPath('userData'))
      return await laneBrainLaunch(workspacePath, folder, brainService)
    } catch (error) {
      log('brain', 'Brain unavailable', { error: String(error) })
      return undefined
    }
  })
}

export async function disposeBrain(): Promise<void> {
  closing = true
  await desktopBrainApp.dispose()
  if (pending) await (await pending.catch(() => undefined))?.dispose()
}
