/**
 * The `archives` section: Desktop's archive manifests, already rewritten by
 * Desktop under new lane ids (V-D1.E3), adopted into `<state>/lane-archive`
 * with a tombstone lane each, so `archive.list` shows them and restore finds
 * its lane. Parked transcripts never move: their path does not depend on the id.
 */
import { join } from 'node:path'
import type { MigrationArchiveManifest } from '@phosphor/shared/host-protocol-owner'
import {
  createLaneArchiveStorage,
  type ArchiveRecord,
} from '@phosphor/session-runtime/lane-archive/storage'
import type { HostStore } from '../../lanes/store'
import type { MigrationImporter } from '../migrate'
import { refuseImport, type ImportPorts } from './ports'
import { keepNames, removeAddedNames } from './snapshot'

/** The archive's own bound (`LaneArchiveStorage.prepare`, `lane_archive_ids`). */
export const ARCHIVE_LIMIT = 1000

export const ARCHIVE_REFUSALS = {
  tooMany: `This Mac has more archived lanes than the Phosphor service can hold (${ARCHIVE_LIMIT}).`,
  taken: 'An archive on this Mac has the same id as a different archived lane on the service.',
} as const

const recordOf = (m: MigrationArchiveManifest): ArchiveRecord => ({ ...m })

/**
 * The tombstone row restore expects. Without the folder or with the store
 * full, the manifest alone is kept: restore re-creates a missing tombstone.
 */
function tombstone(store: HostStore, m: MigrationArchiveManifest): string | null {
  if (store.getLane(m.id)) return null
  if (!store.listRepositories().some((r) => r.id === m.metadata.repositoryId)) return 'folder'
  if (m.transcript && store.sessionLane(m.transcript)) return 'transcript'
  if (store.listLanes().length >= store.limits.lanesPerHost) return 'full'
  store.ensureLane(
    {
      repositoryId: m.metadata.repositoryId,
      cwd: m.cwd,
      sessionFile: m.transcript ?? null,
      title: m.title.slice(0, 80) || null,
      worktree: m.worktree === true,
    },
    { restoreId: m.id },
  )
  store.archives.mark(m.id)
  return null
}

export function archiveImporter(ports: ImportPorts): MigrationImporter<'archives'> {
  const root = join(ports.stateDirectory, 'lane-archive')
  const storage = () => createLaneArchiveStorage(root, ports.sessionsRoot)
  return {
    async apply(section, { store }) {
      const archives = storage()
      const { entries, truncated } = await archives.list()
      const known = new Set(entries.map((e) => e.id))
      const added = section.manifests.filter((m) => !known.has(m.id)).length
      if (truncated || known.size + added > ARCHIVE_LIMIT)
        throw refuseImport('too-large', ARCHIVE_REFUSALS.tooMany)
      const skipped: Record<string, number> = {}
      for (const manifest of section.manifests) {
        try {
          await archives.adopt(recordOf(manifest))
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('This archive ID already'))
            throw refuseImport('forbidden', ARCHIVE_REFUSALS.taken)
          throw error
        }
        const reason = tombstone(store, manifest)
        if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1
      }
      if (Object.keys(skipped).length)
        ports.log('owner.migrate.archive_tombstones_skipped', skipped)
    },
    snapshot: (into) => keepNames(root, into, 'lane-archive'),
    restore: (from) => removeAddedNames(root, from, 'lane-archive'),
  }
}
