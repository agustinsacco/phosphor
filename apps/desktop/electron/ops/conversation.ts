import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { diskLanes, lanePath, liveOpLanes, projectFolders, targetLane } from './lanes'
import {
  op,
  fields,
  pageInventory,
  dataResult,
  pageOffset,
  pageLimit,
  rowTime,
} from '@phosphor/session-runtime/ops/results'

import { matchesLaneState, type LaneActivity } from '@phosphor/shared/host-protocol/lanes'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'

const artifactColumns = {
  ...fields('key', 'title', 'type'),
  lane: (a: { sessionId: string }) => `local/session:${a.sessionId}`,
  updated: (a: { updatedAt: number }) => rowTime(a.updatedAt),
}
const library = async () => (await import('../artifacts/artifact-sync')).artifactLibrary
async function listings() {
  return (await library()).list(liveOpLanes().flatMap((l) => (l.path ? [l.path] : [])))
}
type LaneFilter = { folder?: string; state?: string; q?: string }
async function lanes({ folder, state, q }: LaneFilter, c: OpHandlerContext) {
  const rows = (await diskLanes(folder)).map(({ ref, title, cwd, busy, sessionId, meta }) => ({
    ref,
    title,
    cwd,
    state: (busy ? 'working' : sessionId ? 'idle' : 'stopped') as LaneActivity,
    updated: rowTime(meta?.mtimeMs),
  }))
  const query = q?.toLowerCase()
  return pageInventory(
    rows.filter(
      (l) =>
        matchesLaneState(l.state, state) &&
        (!query || [l.ref, l.title, l.cwd].some((s) => s.toLowerCase().includes(query))),
    ),
    c,
    { ...fields('ref', 'title', 'state'), branch: () => '', ...fields('updated') },
  )
}
export const conversationHandlers = {
  'lane.list': op<LaneFilter>(lanes),
  'lane.search': op<LaneFilter>(lanes),
  'lane.tree': op(async (_, c) => {
    const tree = await (await import('../pi/session-scanner')).readSessionTree(lanePath(c))
    return pageInventory(tree.entries, c, fields('id', 'parentId', 'type', 'label'), {
      wrap: (entries) => ({ sessionId: tree.sessionId, leafId: tree.leafId, entries }),
    })
  }),
  'folder.list': op(async (_, c) => pageInventory(await projectFolders(), c, { path: (p) => p })),
  'lane.read': op<{ part?: string; messages?: number }>(async ({ part, messages = 20 }, c) => {
    const l = targetLane(c)
    if (part === 'messages')
      return pageInventory(
        await (await import('../pi/session-scanner')).readSavedTranscript(lanePath(c)),
        c,
        fields('role', 'content'),
        { limit: pageLimit(c, messages), surface: { limit: messages, shrink: true } },
      )
    if (part === 'artifacts')
      return pageInventory(
        (await listings()).filter((a) => a.sessionFile === lanePath(c)),
        c,
        artifactColumns,
      )
    if (part === 'debug')
      return dataResult({ ref: l.ref, cwd: l.cwd, running: !!l.sessionId, busy: l.busy })
    const meta =
      l.meta ??
      (await (await import('../pi/session-scanner')).listSessions(l.cwd)).find(
        (m) => m.path === l.path,
      )
    return dataResult(
      part === 'prs'
        ? (meta?.pullRequests ?? {})
        : { ref: l.ref, title: l.title, cwd: l.cwd, meta },
    )
  }),
  'archive.list': op<{ measure?: boolean }>(async ({ measure }, c) => {
    const result = await (await import('../archive/state')).localArchives().inventory.list(measure)
    return pageInventory(
      result.entries,
      c,
      {
        ...fields('id', 'title'),
        folder: (a) => a.cwd,
        archived: (a) => rowTime(a.archivedAt),
      },
      { wrap: (entries) => ({ ...result, entries }) },
    )
  }),
  'artifact.list': op<{ lane?: string }>(async ({ lane }, c) =>
    pageInventory(
      (await listings()).filter((a) => !lane || a.sessionFile === lanePath(c)),
      c,
      artifactColumns,
    ),
  ),
  'artifact.read': op<{ key: string; lane?: string; version?: number }>(
    async ({ key, lane, version }, c) => {
      const found = await (await library()).read(key)
      if (!found || (lane && found.listing.sessionFile !== lanePath(c)))
        throw new OpRefusal('bad-request', 'Artifact not found.')
      const row = found.artifact.versions.find(
        (v) => v.version === (version ?? found.listing.version),
      )
      if (!row) throw new OpRefusal('bad-request', 'Version not found.')
      const start = pageOffset(c)
      let end = Math.min(start + 12 * 1024, row.content.length)
      if (/[\uD800-\uDBFF]/.test(row.content.charAt(end - 1))) end--
      const content = row.content.slice(start, end)
      return {
        ...dataResult({ key, version: row.version, title: row.title, content }),
        ...(end < row.content.length ? { next: String(end) } : {}),
      }
    },
  ),
}
