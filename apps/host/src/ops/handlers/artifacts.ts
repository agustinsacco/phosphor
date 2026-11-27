import { join } from 'node:path'
import { isUuid } from '@phosphor/shared/control-api'
import { utf8Length } from '@phosphor/shared/host-protocol'
import {
  ARTIFACT_LIMITS,
  parseArtifactList,
  parseArtifactRead,
  type ArtifactMeta,
} from '@phosphor/shared/host-protocol-artifacts'
import { OPS_LIMITS } from '@phosphor/shared/host-protocol-ops'
import {
  isSessionId,
  readAllIndexes,
  readIndex,
  type SessionArtifactIndex,
} from '@phosphor/session-runtime/artifacts/artifact-indexer'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { op, pageOffset, pageInventory, rowTime } from '@phosphor/session-runtime/ops/results'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { artifactMeta, artifactSessionId, indexForList } from '../../features/artifacts/query'
import { readArtifactVersion } from '../../features/artifacts/read'
import { FeatureFailure } from '../../features/machine'
import { laneCall, laneId, requireCall } from './lane-ports'
import type { DaemonHandlerDeps } from './index'

/** Bound the serialized data (escaping counts), without splitting a Unicode character. */
export function contentPage(
  content: string,
  fields: Record<string, unknown>,
  c: OpHandlerContext,
  start = pageOffset(c),
) {
  if (start > content.length || /[\uDC00-\uDFFF]/.test(content.charAt(start)))
    throw new OpRefusal('bad-request', 'Invalid content offset.')
  const tool = c.principal.kind === 'agent' || c.principal.kind === 'machine'
  const limit = tool ? 16 * 1024 - 2500 : OPS_LIMITS.callDataBytes
  let low = start,
    high = Math.min(content.length, start + limit)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const json = JSON.stringify(
      { ...fields, content: content.slice(start, mid) },
      null,
      tool ? 2 : undefined,
    )
    // pi-extensions marks these results untrusted and HTML-escapes the displayed JSON.
    const bytes = Buffer.byteLength(json) + (tool ? (json.match(/["&<>]/g)?.length ?? 0) * 5 : 0)
    if (bytes <= limit) low = mid
    else high = mid - 1
  }
  if (low < content.length && /[\uD800-\uDBFF]/.test(content.charAt(low - 1))) low--
  if (low === start && low < content.length)
    throw new OpRefusal('too-large', 'Result metadata is too large.')
  const data = { ...fields, content: content.slice(start, low) }
  return {
    text: tool ? JSON.stringify(data) : `Read ${low - start} characters.`,
    data,
    ...(low < content.length ? { next: String(low) } : {}),
  }
}
/** One lane's artifacts, keyed `<laneId>/<slug>`. */
type ArtifactRow = ArtifactMeta & { key: string }
const artifactColumns = {
  key: (a: ArtifactRow) => a.key,
  title: (a: ArtifactRow) => a.title,
  type: (a: ArtifactRow) => a.type,
  lane: (a: ArtifactRow) => a.laneId,
  updated: (a: ArtifactRow) => rowTime(a.versions.at(-1)?.createdAt),
}
function artifactSummary<T extends ArtifactRow>({ versions, ...row }: T) {
  const latest = versions.at(-1)
  return {
    ...row,
    versions: versions.length,
    latest: latest && {
      version: latest.version,
      title: latest.title,
      updated: rowTime(latest.createdAt),
    },
  }
}
function artifactInventory<T extends ArtifactRow>(rows: readonly T[], ctx: OpHandlerContext) {
  return pageInventory(rows, ctx, artifactColumns, {
    surface: { limit: 50, shrink: true },
    agent: {
      row: artifactSummary<T>,
      columns: {
        key: (a) => a.key,
        title: (a) => a.title,
        type: (a) => a.type,
        lane: (a) => a.laneId,
        updated: (a) => a.latest?.updated,
      },
    },
  })
}

export async function artifactList(deps: DaemonHandlerDeps, id: string, c: OpHandlerContext) {
  const items = parseArtifactList(await laneCall(deps, 'artifacts.list', { laneId: id }, c))
  if (!items) throw new OpRefusal('unavailable', 'Invalid artifact list.')
  return artifactInventory(
    items.map((a) => ({ ...a, key: `${a.laneId}/${a.slug}` })),
    c,
  )
}

/**
 * Whom an artifact key's prefix names. A live lane, by its id or its pi
 * session's id; else a conversation no lane holds: a removed lane's session,
 * or one only Desktop's library knew (reconcile-v2 #4).
 */
export function artifactOwner(
  deps: DaemonHandlerDeps,
  prefix: string,
): { laneId: string } | { sessionId: string | null } {
  const lane = isUuid(prefix) ? deps.store.getLane(prefix) : null
  if (lane)
    return lane.removedAt === null
      ? { laneId: lane.laneId }
      : { sessionId: lane.sessionFile ? artifactSessionId(lane.sessionFile) : null }
  const live = deps.store
    .listLanes()
    .find((l) => l.sessionFile !== null && artifactSessionId(l.sessionFile) === prefix)
  return live ? { laneId: live.laneId } : { sessionId: prefix }
}

const storeRoot = (deps: DaemonHandlerDeps) =>
  deps.stateDirectory ? join(deps.stateDirectory, 'artifacts') : null

type LibraryRow = ArtifactMeta & { key: string; sessionDeleted?: true }
interface Dropped {
  invalid: number
  overCaps: number
}

/** Classify and validate before paging: neither a bad slug nor a single
 * oversized row should invalidate every page of an otherwise usable store. */
function appendIndex(
  rows: LibraryRow[],
  index: SessionArtifactIndex,
  owner: { laneId: string } | null,
  dropped: Dropped,
) {
  for (const stored of Object.values(index.artifacts)) {
    const meta = artifactMeta(owner?.laneId ?? index.sessionId, stored)
    if (!meta) continue
    const parsed = parseArtifactList([meta])?.[0]
    const row = parsed && {
      ...parsed,
      key: `${parsed.laneId}/${parsed.slug}`,
      ...(!owner && { sessionDeleted: true as const }),
    }
    if (!row || utf8Length(JSON.stringify([row])) > OPS_LIMITS.callDataBytes) dropped.invalid++
    else rows.push(row)
  }
}

/** Live lanes have priority. Within each group keep the newest rows that fit
 * the client's count and metadata caps, with a stable order for equal times. */
function boundedRows(candidates: LibraryRow[], dropped: Dropped) {
  candidates.sort(
    (a, b) =>
      Number(!!a.sessionDeleted) - Number(!!b.sessionDeleted) ||
      b.versions.at(-1)!.createdAt - a.versions.at(-1)!.createdAt ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
  const rows: LibraryRow[] = []
  const keys = new Set<string>()
  let bytes = 0
  for (const row of candidates) {
    const { key, ...counted } = row
    if (keys.has(key)) continue
    // ownerLibrary counts parsed metadata, including sessionDeleted but not key.
    const size = utf8Length(JSON.stringify(counted))
    if (rows.length >= ARTIFACT_LIMITS.count || bytes + size > ARTIFACT_LIMITS.metadataBytes) {
      dropped.overCaps++
      continue
    }
    keys.add(key)
    bytes += size
    rows.push(row)
  }
  return rows
}

async function libraryRows(deps: DaemonHandlerDeps, c: OpHandlerContext, dropped: Dropped) {
  requireCall(deps, 'artifacts.list', c)
  const root = storeRoot(deps)
  if (!root) throw new OpRefusal('unavailable', 'Artifacts are unavailable on this machine.')
  const rows: LibraryRow[] = []
  const skipped = (laneId: string, reason: string) =>
    deps.log('artifacts', 'artifact-lane-skipped', { laneId, reason })
  for (const lane of deps.store.listLanes()) {
    if (!lane.sessionFile || lane.removedAt !== null) continue
    c.signal.throwIfAborted()
    const index = await indexForList(root, { store: deps.store, skipped }, lane.laneId)
    if (index) appendIndex(rows, index, lane, dropped)
  }
  c.signal.throwIfAborted()
  // Recheck membership after the async scans; deletion while indexing must not
  // surface a dead lane link. Its saved index gets a session key instead.
  const lanes = deps.store.listLanes().filter((l) => l.removedAt === null)
  const held = new Set(lanes.map((l) => l.sessionFile && artifactSessionId(l.sessionFile)))
  const live = new Set(lanes.map((l) => l.laneId))
  const candidates = rows.filter((row) => live.has(row.laneId))
  for (const index of readAllIndexes(root)) {
    if (!held.has(index.sessionId)) appendIndex(candidates, index, null, dropped)
  }
  return boundedRows(candidates, dropped)
}

/** A conversation no lane holds: its artifact read from the daemon's store. */
async function readUnowned(
  deps: DaemonHandlerDeps,
  sessionId: string | null,
  slug: string,
  version: number | undefined,
  c: OpHandlerContext,
) {
  requireCall(deps, 'artifacts.read', c)
  const root = storeRoot(deps)
  const index = root && sessionId && isSessionId(sessionId) ? readIndex(root, sessionId) : null
  if (!root || !index || !Object.hasOwn(index.artifacts, slug))
    throw new OpRefusal('bad-request', 'No artifact has that key.')
  try {
    return await readArtifactVersion(root, index, slug, version)
  } catch (error) {
    if (error instanceof FeatureFailure)
      throw new OpRefusal(
        error.code === 'too-large' ? 'too-large' : 'bad-request',
        'No artifact has that key.',
      )
    throw error
  }
}

export function artifactHandlers(deps: DaemonHandlerDeps) {
  let reported = ''
  /** Logs once per change in what was dropped, not once per page. */
  const report = (dropped: Dropped) => {
    const now = JSON.stringify(dropped)
    if (now === reported) return
    reported = now
    if (dropped.invalid || dropped.overCaps)
      deps.log('artifacts', 'library rows dropped', { ...dropped })
  }
  return {
    'artifact.list': op<{ lane?: string }>(async ({ lane }, c) => {
      if (lane) return artifactList(deps, laneId(deps, c), c)
      const dropped = { invalid: 0, overCaps: 0 }
      const rows = await libraryRows(deps, c, dropped)
      report(dropped)
      return artifactInventory(rows, c)
    }),
    'artifact.read': op<{ key: string; lane?: string; version?: number }>(
      async ({ key, lane, version }, c) => {
        const parts = key.split('/')
        if (parts.length > 2)
          throw new OpRefusal('bad-request', 'Artifact key does not belong to this lane.')
        const owner =
          parts.length === 2 ? artifactOwner(deps, parts[0]!) : { laneId: laneId(deps, c) }
        if (lane && !('laneId' in owner && owner.laneId === laneId(deps, c)))
          throw new OpRefusal('bad-request', 'Artifact key does not belong to this lane.')
        const slug = parts.at(-1)!
        const result =
          'laneId' in owner
            ? parseArtifactRead(
                await laneCall(deps, 'artifacts.read', { laneId: owner.laneId, slug, version }, c),
              )
            : await readUnowned(deps, owner.sessionId, slug, version, c)
        if (!result) throw new OpRefusal('unavailable', 'Invalid artifact response.')
        return contentPage(result.content, { key, version: result.version }, c)
      },
    ),
  }
}
