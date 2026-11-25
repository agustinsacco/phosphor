/**
 * The `lanes` section: one daemon lane per session file Desktop's sidebar
 * shows, under the lane id Desktop minted, with its title, branch, model and
 * times. `ensureLane` is keyed by session file, so a replay or a merge with a
 * lane the daemon already knows keeps that lane. Desktop sends no model, so
 * each lane's comes from its transcript, as the start-up repair reads it.
 */
import type { MigrationLaneItem } from '@phosphor/shared/host-protocol-owner'
import type { HostStore } from '../../lanes/store'
import { MODEL_REPAIR_BUDGET_BYTES, recordedModelReader } from '../../lanes/reconcile/models'
import type { MigrationImporter } from '../migrate'
import { withStateDatabase } from '../staging'
import { refuseImport, type ImportPorts } from './ports'

export const LANE_REFUSALS = {
  folder: 'A lane’s folder was not imported. Import the folders first.',
  tooMany: (limit: number) =>
    `This Mac has more lanes than the Phosphor service can hold (${limit}).`,
} as const

/** The store's column bounds; a longer model name is dropped, never the lane. */
const fitsModel = (model: MigrationLaneItem['model']) =>
  !!model && model.provider.length <= 64 && model.id.length <= 128

/** Every item's repository id, checked before anything is written. */
function repositoryIds(store: HostStore, items: readonly MigrationLaneItem[]): string[] {
  const byPath = new Map(store.listRepositories().map((r) => [r.path, r.id]))
  return items.map((item) => {
    const id = byPath.get(item.rootPath)
    if (!id) throw refuseImport('bad-request', LANE_REFUSALS.folder)
    return id
  })
}

/** Lanes the import would add or bring back, against the store's live-lane cap. */
function requireRoom(store: HostStore, items: readonly MigrationLaneItem[]) {
  const added = items.filter((item) => {
    const known = store.sessionLane(item.sessionFile)
    return !known || (known.removedAt !== null && !store.archives.has(known.laneId))
  }).length
  const limit = store.limits.lanesPerHost
  if (store.listLanes().length + added > limit)
    throw refuseImport('too-large', LANE_REFUSALS.tooMany(limit))
}

export function laneImporter(ports: ImportPorts): MigrationImporter<'lanes'> {
  return {
    async apply(section, { store }) {
      const repositories = repositoryIds(store, section.items)
      requireRoom(store, section.items)
      const times: [laneId: string, createdAt: number, updatedAt: number][] = []
      let models = 0
      const recorded = recordedModelReader(ports.sessionsRoot, MODEL_REPAIR_BUDGET_BYTES)
      section.items.forEach((item, i) => {
        const model = item.model
          ? fitsModel(item.model)
            ? item.model
            : null
          : recorded.read(item.sessionFile).model
        if (item.model && !model) models++
        if (!item.model && model) recorded.counts.repaired++
        const lane = store.ensureLane(
          {
            repositoryId: repositories[i]!,
            cwd: item.cwd,
            sessionFile: item.sessionFile,
            worktree: item.worktree,
            title: item.title,
            branch: item.branch,
            provider: model?.provider ?? null,
            model: model?.id ?? null,
          },
          { restoreId: item.laneId },
        )
        if (lane.laneId !== item.laneId)
          ports.log('owner.migrate.lane_kept', { laneId: lane.laneId })
        else times.push([lane.laneId, Date.parse(item.createdAt), Date.parse(item.updatedAt)])
      })
      if (models) ports.log('owner.migrate.lane_models_dropped', { count: models })
      if (!section.items.every((item) => item.model))
        ports.log('owner.migrate.lane_models_read', { ...recorded.counts })
      // ensureLane stamps both times now; Desktop's order and recency come from the files.
      await withStateDatabase(ports.stateDirectory, ports.uid, (db) => {
        const update = db.prepare('UPDATE lanes SET created_at=?,updated_at=? WHERE lane_id=?')
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const [id, created, updated] of times)
            update.run(Math.min(created, updated), updated, id)
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      })
    },
  }
}
