/**
 * The Brain handover's place in launch: after the runtime mode is decided and before any window
 * or Brain start. In daemon mode, with a migration permit, an unfinished move is settled and a
 * new one starts when the service says it can take the Brain. In any other mode only an
 * unfinished move is settled; Desktop never starts one into a service that is not running lanes.
 */
import { join } from 'node:path'
import { app } from 'electron'
import { embeddingModelPaths } from '@phosphor/brain-runtime/embedding/embedding-files'
import { EMBEDDING_MODEL } from '@phosphor/brain-runtime/embedding/model-manifest'
import type { LocalRuntimeMode } from '@phosphor/shared/ipc'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { loadSqlite, loadSqliteBackup } from '@phosphor/session-runtime/sqlite'
import { brainLaneFolder } from '../../brain/lane-folder'
import {
  brainHandoverPaths,
  desktopBrainOwner,
  finishBrainOwnerLaunch,
  readBrainHandoverRecord,
  type DesktopBrainOwner,
} from '../../brain/owner-gate'
import { log } from '../../debug-log'
import { installedBrainStateDirectory, openServiceChannel } from '../migration/desktop-ports'
import type { MigrationPermit } from '../migration/journal'
import { resolveBrainHandover, runBrainHandover, type BrainHandoverRunPorts } from './runner'

import { selectBrainOwnerAtLaunch } from './selection'
import { fenceEmptyDesktopBrain, matchesEmptyDesktopFence } from './tombstone'
import { desktopBrainApp } from '../../brain/app-service'

function runPorts(
  userData: string,
  beforeHostOwnership: () => Promise<void>,
): BrainHandoverRunPorts {
  const laneFolder = brainLaneFolder(userData)
  return {
    userData,
    beforeHostOwnership,
    desktopVersion: app.getVersion(),
    sources: {
      sqlite: { DatabaseSync: loadSqlite().DatabaseSync, backup: loadSqliteBackup() },
      database: brainHandoverPaths(userData).legacy,
      laneFolder,
      transcripts: sessionDirForCwd(laneFolder),
      model: {
        folder: embeddingModelPaths(join(userData, 'brain', 'embeddings')).model,
        directoryName: EMBEDDING_MODEL.directoryName,
        files: EMBEDDING_MODEL.files.map(({ path, bytes }) => ({ path, bytes })),
      },
    },
    log: (event, fields) => log('brain', event, fields),
  }
}

export async function settleBrainOwnerAtLaunch(
  mode: LocalRuntimeMode,
  permit: MigrationPermit,
): Promise<void> {
  const userData = app.getPath('userData')
  let owner: DesktopBrainOwner = 'moving'
  let stateDir: string | undefined
  try {
    stateDir = installedBrainStateDirectory()
    owner = await choose(userData, mode, permit, stateDir)
  } catch {
    log('brain', 'brain owner refused at launch')
  } finally {
    finishBrainOwnerLaunch(userData, owner, stateDir)
    desktopBrainApp.brainChanged()
  }
}

async function choose(
  userData: string,
  mode: LocalRuntimeMode,
  permit: MigrationPermit,
  stateDir: string | undefined,
): Promise<DesktopBrainOwner> {
  const record = readBrainHandoverRecord(userData)
  if (record?.phase === 'committed') return 'host'
  const unfinished = record?.phase === 'fenced' || record?.phase === 'tombstoned'
  const allowHost = mode === 'daemon' && permit.allowed
  const channel =
    unfinished || mode === 'daemon' || stateDir
      ? await openServiceChannel().catch(() => null)
      : null
  const beforeHostOwnership = async () => {
    if ((await channel?.call('owner.brainHandover.pin', undefined))?.pinned !== true)
      throw new Error('The Phosphor service installation is not pinned.')
  }
  try {
    if (unfinished) {
      const outcome = await resolveBrainHandover(runPorts(userData, beforeHostOwnership), channel)
      log('brain', 'brain handover at launch', { outcome })
      if (outcome !== 'aborted') return desktopBrainOwner(userData)
    }
    const owner = await selectBrainOwnerAtLaunch({
      userData,
      legacyTranscripts: sessionDirForCwd(brainLaneFolder(userData)),
      stateDir,
      channel,
      allowHost,
      standalone: mode === 'in-app',
      beforeHostOwnership,
      fenceEmptyLegacy: (id) => fenceEmptyDesktopBrain(userData, loadSqlite().DatabaseSync, id),
      matchesLegacyFence: (id) => matchesEmptyDesktopFence(userData, loadSqlite().DatabaseSync, id),
    })
    if (owner !== 'desktop' || !allowHost || !channel || !stateDir || unfinished) return owner
    const outcome = await runBrainHandover(runPorts(userData, beforeHostOwnership), channel)
    log('brain', 'brain handover at launch', { outcome })
    return desktopBrainOwner(userData)
  } finally {
    channel?.close()
  }
}
