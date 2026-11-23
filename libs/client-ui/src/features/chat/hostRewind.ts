import { sessionBranch } from '@shared/session-branch'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { readHostTree, useLaneEditing, type HostEditLane } from './hostLaneEditing'
import type { BranchUserMessage } from './rewind'
import type { UserItem } from './chatItems'

export function sessionHostLane(id: string): HostEditLane | undefined {
  const entry = useSessionsStore.getState().live[id]
  return entry?.target?.kind === 'remote' && entry.laneId
    ? { hostId: entry.target.hostId, laneId: entry.laneId }
    : undefined
}
export function useRewindAvailable(id: string) {
  const target = useSessionsStore((s) => s.live[id]?.target)
  const hostId = target?.kind === 'remote' ? target.hostId : undefined
  const editing = useLaneEditing(hostId)
  return !hostId || editing
}
/** Host rows have a bounded preview, not the message body. Never infer an entry id from it. */
export async function hostBranchMessages(
  id: string,
  lane: HostEditLane,
): Promise<BranchUserMessage[]> {
  const tree = await readHostTree(lane)
  const branch = sessionBranch(tree.entries, tree.leafId).filter(
    (e) => e.type === 'message' && e.role === 'user',
  )
  const rendered =
    useChatStore
      .getState()
      .sessions[id]?.items.filter((i): i is UserItem => i.kind === 'user' && !i.optimistic) ?? []
  const counts = new Map<number, number>()
  for (const { messageTimestamp: t } of branch)
    if (t !== undefined) counts.set(t, (counts.get(t) ?? 0) + 1)
  const rows = new Map<number, UserItem | null>()
  for (const row of rendered)
    if (row.timestamp !== undefined) rows.set(row.timestamp, rows.has(row.timestamp) ? null : row)
  return branch.map((e) => {
    const t = e.messageTimestamp
    const unique = t !== undefined && counts.get(t) === 1 ? rows.get(t) : null
    return {
      entryId: e.id,
      text: unique?.text ?? e.preview ?? '',
      timestamp: unique ? t : undefined,
      images: unique?.images,
    }
  })
}
