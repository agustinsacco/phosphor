import {
  indexSessionFile,
  writeIndex,
  type SessionArtifactIndex,
} from '@phosphor/session-runtime/artifacts/artifact-indexer'
import {
  ARTIFACT_LIMITS,
  parseArtifactList,
  type ArtifactMeta,
} from '@phosphor/shared/host-protocol-artifacts'
import { utf8Length } from '@phosphor/shared/host-protocol'
import type { HostStore } from '../../lanes/store'
import type { FeatureOutcome } from '../feature'
import { FeatureFailure } from '../machine'

export interface ArtifactLanePorts {
  store: Pick<HostStore, 'getLane' | 'listLanes'>
  admitted(laneId: string): boolean
  requireLane(laneId: string): void
}

export async function indexArtifacts(
  root: string,
  store: Pick<HostStore, 'getLane'>,
  laneId: string,
): Promise<SessionArtifactIndex | null> {
  const lane = store.getLane(laneId)
  if (!lane || lane.removedAt !== null) throw new FeatureFailure('unknown-lane')
  if (!lane.sessionFile) return null
  const saved = await indexSessionFile(root, lane.sessionFile, null, ARTIFACT_LIMITS.sessionBytes)
  if (saved) await writeIndex(root, saved)
  return saved
}

export async function listArtifacts(
  root: string,
  ports: ArtifactLanePorts,
  requestedLaneId?: string,
): Promise<FeatureOutcome> {
  const lanes = requestedLaneId
    ? [requestedLaneId]
    : ports.store
        .listLanes()
        .filter((l) => l.removedAt === null)
        .map((l) => l.laneId)
  if (lanes.length > ARTIFACT_LIMITS.count) throw new FeatureFailure('too-large')
  const items: ArtifactMeta[] = []
  let metadataBytes = 0
  for (const laneId of lanes) {
    if (!requestedLaneId && !ports.admitted(laneId)) continue
    const saved = await indexArtifacts(root, ports.store, laneId)
    if (!saved) continue
    for (const a of Object.values(saved.artifacts)) {
      const versions = a.versions.filter((v) => v.onBranch).sort((a, b) => a.version - b.version)
      if (!versions.length) continue
      const item: ArtifactMeta = {
        laneId,
        slug: a.slug,
        title: a.title,
        type: a.type,
        ...(a.language ? { language: a.language } : {}),
        versions: versions.map((v) => ({
          version: v.version,
          title: v.title,
          createdAt: Date.parse(v.createdAt) || 0,
          bytes: v.bytes,
        })),
      }
      metadataBytes += utf8Length(JSON.stringify(item))
      if (metadataBytes > ARTIFACT_LIMITS.metadataBytes) throw new FeatureFailure('too-large')
      items.push(item)
      if (items.length > ARTIFACT_LIMITS.count) throw new FeatureFailure('too-large')
    }
  }
  if (!parseArtifactList(items)) throw new FeatureFailure('too-large')
  if (requestedLaneId) ports.requireLane(requestedLaneId)
  return { ok: true, data: items.filter((item) => ports.admitted(item.laneId)) }
}
