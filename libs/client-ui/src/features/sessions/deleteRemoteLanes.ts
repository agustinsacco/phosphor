import { laneControlPolicy, ensureServiceLaneControl } from '@/platform/serviceLaneControl'
import { archiveRemoteLane } from './archiveRemoteLane'
import type { HostLaneView } from '@shared/ipc'
import { remoteLaneResourceKey } from '@shared/remote-host'
import { runLaneRemoval } from '@/stores/laneRemovalRun'
import { forgetRemoteSession, useSessionsStore } from '@/stores/sessions'
import { machineCaps } from '@/stores/machineCaps'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

export function canDeleteRemoteLane(hostId: string, lane: HostLaneView): boolean {
  const host = useRemoteLanesStore.getState().hosts[hostId]
  return (
    machineCaps(host).can('sessions.control', 'workspaces.write') &&
    laneControlPolicy(host?.local, lane).actionable
  )
}
export function canArchiveRemoteLane(hostId: string, lane: HostLaneView): boolean {
  return (
    useRemoteLanesStore.getState().hosts[hostId]?.laneArchive === true &&
    canDeleteRemoteLane(hostId, lane)
  )
}
async function removeLane(
  hostId: string,
  laneId: string,
  completed: Set<string>,
  options: {
    removeWorktree: boolean
    deleteBranch: boolean
    archive?: boolean
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
  if (!options.archive) await ensureServiceLaneControl(hostId, laneId)
  const result = options.archive
    ? (await archiveRemoteLane(hostId, laneId), { branchKept: false })
    : await window.phosphor.invoke('hosts:deleteLane', hostId, laneId, {
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
/** Uses the shared bulk progress/cancel runner; never takes control or retries an uncertain command. */
export async function deleteRemoteLanes(
  hostId: string,
  lanes: HostLaneView[],
  options: {
    removeWorktree: boolean
    deleteBranch: boolean
    archive?: boolean
  },
): Promise<void> {
  const completed = new Set<string>()
  await runLaneRemoval(
    {
      read: () => useSessionsStore.getState().bulkDelete,
      write: (bulkDelete) => useSessionsStore.setState({ bulkDelete }),
    },
    {
      archiving: options.archive,
      lanes: lanes.map((lane) => ({
        laneId: lane.laneId,
        path: remoteLaneResourceKey(hostId, lane.laneId),
        title: lane.title || 'Untitled lane',
      })),
      prepare: async () => (lane) => removeLane(hostId, lane.laneId, completed, options),
      failureText: (error) =>
        options.archive && error instanceof Error
          ? error.message
          : 'The Host could not confirm deletion. Check this lane before retrying.',
    },
  )
}
