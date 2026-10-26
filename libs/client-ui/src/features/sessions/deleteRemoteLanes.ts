import type { HostLaneView } from '@shared/ipc'
import { hostResourceKey } from '@shared/remote-host'
import { forgetRemoteSession, useSessionsStore, type LaneDeleteResult } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

export const remoteLaneKey = (hostId: string, laneId: string): string =>
  hostResourceKey({ kind: 'remote', hostId }, 'session', laneId)
export function canDeleteRemoteLane(hostId: string, lane: HostLaneView): boolean {
  const host = useRemoteLanesStore.getState().hosts[hostId]
  return (
    host?.state === 'ready' &&
    host.capabilities.includes('sessions.control') &&
    host.capabilities.includes('workspaces.write') &&
    lane.control.controller?.self === true
  )
}
async function removeLane(
  hostId: string,
  laneId: string,
  completed: Set<string>,
  options: {
    removeWorktree: boolean
    deleteBranch: boolean
  },
): Promise<string | undefined> {
  const host = useRemoteLanesStore.getState().hosts[hostId]
  const lane = host?.lanes.find((l) => l.laneId === laneId)
  if (!lane || !canDeleteRemoteLane(hostId, lane))
    throw new Error('Lane unavailable or no longer controlled by you.')
  const ownsWorktree =
    lane.worktree &&
    !host?.lanes.some(
      (other) => other.laneId !== laneId && other.cwd === lane.cwd && !completed.has(other.laneId),
    )
  const result = await window.phosphor.invoke('hosts:deleteLane', hostId, laneId, {
    removeWorktree: ownsWorktree && options.removeWorktree,
    removeBranch: ownsWorktree && options.removeWorktree && options.deleteBranch,
  })
  completed.add(laneId)
  const entries = Object.values(useSessionsStore.getState().live).filter(
    (e) => e.target?.kind === 'remote' && e.target.hostId === hostId && e.laneId === laneId,
  )
  for (const entry of entries) await forgetRemoteSession(entry.phosphorId)
  return result.branchKept ? "Branch kept: it isn't merged yet." : undefined
}
/** Uses the existing global progress/cancel surface; never takes control or retries an uncertain command. */
export async function deleteRemoteLanes(
  hostId: string,
  lanes: HostLaneView[],
  options: {
    removeWorktree: boolean
    deleteBranch: boolean
  },
): Promise<void> {
  if (useSessionsStore.getState().bulkDelete?.running) return
  const targets = lanes.map((lane) => ({
    path: remoteLaneKey(hostId, lane.laneId),
    title: lane.title || 'Untitled lane',
  }))
  useSessionsStore.setState({
    bulkDelete: {
      lanes: targets,
      total: targets.length,
      done: 0,
      current: '',
      currentPath: '',
      results: [],
      running: true,
      cancelled: false,
    },
  })
  const completed = new Set<string>()
  try {
    for (const [index, lane] of lanes.entries()) {
      if (useSessionsStore.getState().bulkDelete?.cancelled) break
      const target = targets[index]!
      update({ current: target.title, currentPath: target.path })
      let result: LaneDeleteResult
      try {
        const error = await removeLane(hostId, lane.laneId, completed, options)
        result = { ...target, ok: true, ...(error ? { error } : {}) }
      } catch {
        result = {
          ...target,
          ok: false,
          error: 'The Host could not confirm deletion. Check this lane before retrying.',
        }
      }
      const progress = useSessionsStore.getState().bulkDelete!
      update({ results: [...progress.results, result], done: progress.done + 1 })
    }
  } finally {
    update({ running: false, current: '', currentPath: '' })
  }
}
function update(
  patch: Partial<NonNullable<ReturnType<typeof useSessionsStore.getState>['bulkDelete']>>,
): void {
  useSessionsStore.setState((s) =>
    s.bulkDelete ? { bulkDelete: { ...s.bulkDelete, ...patch } } : s,
  )
}
