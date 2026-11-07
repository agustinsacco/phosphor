import {
  indexSessionFile,
  readIndex,
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
  /** A lane the all-lanes list left out, and why. */
  skipped?(laneId: string, reason: string): void
}

/** pi names session files `<timestamp>_<session id>.jsonl`; the store keys on that id. */
const PI_SESSION_FILE = /_([0-9A-Za-z-]{8,128})\.jsonl$/

/**
 * The index this file was last saved under, to resume from. A wrong guess only
 * costs a full scan: the indexer resumes only an index of this very file.
 */
function savedIndex(root: string, sessionFile: string): SessionArtifactIndex | null {
  const id = PI_SESSION_FILE.exec(sessionFile)?.[1]
  return id ? readIndex(root, id) : null
}

export async function indexArtifacts(
  root: string,
  store: Pick<HostStore, 'getLane'>,
  laneId: string,
): Promise<SessionArtifactIndex | null> {
  const lane = store.getLane(laneId)
  if (!lane || lane.removedAt !== null) throw new FeatureFailure('unknown-lane')
  if (!lane.sessionFile) return null
  const previous = savedIndex(root, lane.sessionFile)
  const saved = await indexSessionFile(
    root,
    lane.sessionFile,
    previous,
    ARTIFACT_LIMITS.sessionBytes,
  )
  if (saved && saved !== previous) await writeIndex(root, saved)
  return saved
}

/**
 * One lane's index for the all-lanes list. A lane that cannot be scanned (its
 * first scan is past the cap, its file unreadable) is left out and logged, so
 * it never blanks every other lane on this Host.
 */
async function indexForList(
  root: string,
  ports: ArtifactLanePorts,
  laneId: string,
): Promise<SessionArtifactIndex | null> {
  try {
    return await indexArtifacts(root, ports.store, laneId)
  } catch (error) {
    if (error instanceof FeatureFailure) throw error
    const tooLarge = error instanceof Error && error.message === 'session-too-large'
    ports.skipped?.(laneId, tooLarge ? 'too-large' : 'internal')
    return null
  }
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
    const saved = requestedLaneId
      ? await indexArtifacts(root, ports.store, laneId)
      : await indexForList(root, ports, laneId)
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
