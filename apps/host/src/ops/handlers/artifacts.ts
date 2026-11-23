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
} from '@phosphor/session-runtime/artifacts/artifact-indexer'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { op, pageOffset, pageRows } from '@phosphor/session-runtime/ops/results'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { artifactMeta, artifactSessionId } from '../../features/artifacts/query'
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
export async function artifactList(deps: DaemonHandlerDeps, id: string, c: OpHandlerContext) {
  const items = parseArtifactList(await laneCall(deps, 'artifacts.list', { laneId: id }, c))
  if (!items) throw new OpRefusal('unavailable', 'Invalid artifact list.')
  return pageRows(
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

/** What M5c's `ownerLibrary` counts for one row: its parsed metadata, `sessionDeleted` too. */
const rowBytes = (row: ArtifactMeta & { sessionDeleted?: true }) => utf8Length(JSON.stringify(row))

/**
 * Rows for every conversation in the store that no live lane holds, newest
 * first, as `<session id>/<slug>`. A row the client's parser would refuse is
 * dropped, never sent: one bad index must not fail the whole library.
 */
function unownedRows(deps: DaemonHandlerDeps, root: string, dropped: Dropped): LibraryRow[] {
  const held = new Set(
    deps.store
      .listLanes()
      .flatMap((l) => (l.sessionFile ? [artifactSessionId(l.sessionFile)] : [])),
  )
  const rows: (LibraryRow & { at: number })[] = []
  for (const index of readAllIndexes(root)) {
    if (held.has(index.sessionId)) continue
    for (const stored of Object.values(index.artifacts)) {
      const meta = artifactMeta(index.sessionId, stored)
      const parsed = meta && parseArtifactList([meta])?.[0]
      const row = parsed && {
        ...parsed,
        key: `${parsed.laneId}/${parsed.slug}`,
        sessionDeleted: true as const,
      }
      // A row past one page's data would fail every page from its own on.
      if (!row || utf8Length(JSON.stringify([row])) > OPS_LIMITS.callDataBytes) {
        if (meta) dropped.invalid++
        continue
      }
      rows.push({ ...row, at: row.versions.at(-1)?.createdAt ?? 0 })
    }
  }
  return rows
    .sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ at: _, ...row }) => row)
}

/**
 * The library: live lanes' rows first, then conversations no lane holds,
 * newest first. Past the client's row and metadata caps the oldest of those
 * are dropped, so `ownerLibrary` never refuses a valid library.
 */
async function libraryRows(deps: DaemonHandlerDeps, c: OpHandlerContext, dropped: Dropped) {
  const live = parseArtifactList(await laneCall(deps, 'artifacts.list', {}, c))
  if (!live) throw new OpRefusal('unavailable', 'Invalid artifact list.')
  const rows: LibraryRow[] = live.map((a) => ({ ...a, key: `${a.laneId}/${a.slug}` }))
  const root = storeRoot(deps)
  if (!root) return rows
  const keys = new Set(rows.map((r) => r.key))
  let bytes = live.reduce((sum, a) => sum + rowBytes(a), 0)
  for (const row of unownedRows(deps, root, dropped)) {
    const { key: _, ...counted } = row
    if (keys.has(row.key)) continue
    if (
      rows.length >= ARTIFACT_LIMITS.count ||
      bytes + rowBytes(counted) > ARTIFACT_LIMITS.metadataBytes
    ) {
      dropped.overCaps++
      continue
    }
    bytes += rowBytes(counted)
    keys.add(row.key)
    rows.push(row)
  }
  return rows
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
      return pageRows(rows, c)
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
