import type { HostConnectionView, HostLaneView, SessionTree, SessionTreeEntry } from '@shared/ipc'
import type { ImageContent } from '@shared/rpc'
import { isUuid } from '@shared/control-api'
import { remoteLaneKey, remoteLaneResourceKey } from '@shared/remote-host'
import { visibleLane } from '@phosphor/shared/visible-lanes'
import { runAgentOp } from '@/features/agent-control/agentOps'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useDraftsStore } from '@/stores/drafts'
import { fromImageContents } from './attachments'

export type HostEditLane = { hostId: string; laneId: string }
export function offersLaneEditing(host?: HostConnectionView) {
  return host?.state === 'ready' && host.ops === true && host.laneEditing === true
}
export function useLaneEditing(hostId?: string) {
  return useRemoteLanesStore((s) => offersLaneEditing(hostId ? s.hosts[hostId] : undefined))
}
function run(
  { hostId, laneId }: HostEditLane,
  op: string,
  args: Record<string, unknown> = {},
  page?: string,
) {
  if (!offersLaneEditing(useRemoteLanesStore.getState().hosts[hostId]))
    throw new Error('Lane editing is unavailable on this machine.')
  return runAgentOp(hostId, `lane.${op}`, { ref: laneId, ...args }, page)
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function treeEntry(v: unknown): v is SessionTreeEntry {
  return (
    record(v) &&
    typeof v.id === 'string' &&
    typeof v.type === 'string' &&
    typeof v.timestamp === 'string' &&
    (v.parentId === null || typeof v.parentId === 'string') &&
    [
      'role',
      'preview',
      'toolName',
      'targetId',
      'label',
      'summary',
      'name',
      'provider',
      'modelId',
      'thinkingLevel',
    ].every((k) => v[k] === undefined || typeof v[k] === 'string') &&
    (v.messageTimestamp === undefined || Number.isSafeInteger(v.messageTimestamp))
  )
}
const unreadable = () =>
  new Error('The machine returned an unreadable lane. Close and reopen the tree to retry.')
export async function readHostTree(lane: HostEditLane): Promise<SessionTree> {
  let tree: SessionTree | undefined, page: string | undefined
  const pages = new Set<string>(),
    ids = new Set<string>(),
    parents = new Set<string>()
  do {
    const { data, next } = await run(lane, 'tree', {}, page)
    if (
      !record(data) ||
      typeof data.sessionId !== 'string' ||
      (data.leafId !== null && typeof data.leafId !== 'string') ||
      !Array.isArray(data.entries) ||
      !data.entries.every(treeEntry)
    )
      throw unreadable()
    tree ??= { sessionId: data.sessionId, leafId: data.leafId, cwd: '', entries: [] }
    if (tree.sessionId !== data.sessionId || tree.leafId !== data.leafId)
      throw new Error('The lane changed while loading its tree. Reopen the tree to retry.')
    for (const entry of data.entries) {
      // pi appends parents before children. Never hand the layout a cycle or a duplicated page.
      if (entry.parentId) parents.add(entry.parentId)
      if (parents.has(entry.id) || ids.has(entry.id)) throw unreadable()
      ids.add(entry.id)
      tree.entries.push(entry)
    }
    if (next && (pages.has(next) || !data.entries.length)) throw unreadable()
    if (next) pages.add(next)
    page = next
  } while (page)
  return tree
}
export async function editHostEntry(
  lane: HostEditLane,
  op: 'jump' | 'label',
  entry: string,
  label?: string,
) {
  await run(lane, op, { entry, ...(label ? { label } : {}) })
}
export async function copyHostLane(
  source: HostEditLane,
  kind: 'fork' | 'clone' | 'rewind',
  at?: string,
  images?: ImageContent[],
): Promise<HostEditLane> {
  const { hostId } = source
  const { data } = await run(source, kind, at ? { [kind === 'rewind' ? 'entry' : 'at']: at } : {})
  if (!record(data) || typeof data.lane !== 'string') throw unreadable()
  const laneId = data.lane.split('/lane:').at(-1)
  if (!isUuid(laneId) || laneId === source.laneId) throw unreadable()
  const host = useRemoteLanesStore.getState().hosts[hostId]
  if (
    data.lane !== laneId &&
    ![hostId, host?.enrolledHostId].some((id) => id && data.lane === remoteLaneKey(id, laneId))
  )
    throw unreadable()
  if (kind === 'rewind') {
    if (typeof data.prefill !== 'string') throw unreadable()
    useDraftsStore.getState().patch(remoteLaneResourceKey(hostId, laneId), {
      text: data.prefill,
      attachments: fromImageContents(images ?? []),
    })
  }
  return { hostId, laneId }
}

/** The same presence, cycle, live and pinned exceptions as Desktop's file-based fold. */
export function visibleHostLanes(lanes: HostLaneView[]) {
  const links = Object.fromEntries(
    lanes.flatMap((l) => (l.rewoundFrom ? [[l.rewoundFrom, l.laneId]] : [])),
  )
  const present = new Set(lanes.map((l) => l.laneId))
  return lanes.filter((l) =>
    visibleLane(l.laneId, links, present, {
      pinned: l.pinned,
      live: l.activity !== 'stopped' && l.activity !== 'failed',
    }),
  )
}
