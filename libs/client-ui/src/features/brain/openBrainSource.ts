import { useSessionsStore } from '@/stores/sessions'
import { navigateToLane } from '@/stores/remoteLanes'
import { openSidebarConversation } from '@/features/sessions/completionActions'

/** Resolve current metadata on click, then use the sidebar's disk/live opening path. */
export async function openBrainSource(sessionPath: string): Promise<void> {
  const sessions = useSessionsStore.getState()
  const live = Object.values(sessions.live).find((entry) => entry.diskPath === sessionPath)
  if (live) {
    await navigateToLane({ sessionId: live.phosphorId })
    return
  }
  const tree = await window.phosphor.invoke('sessions:readTree', sessionPath)
  await sessions.refreshDisk(tree.cwd)
  const meta = useSessionsStore
    .getState()
    .disk[tree.cwd]?.find((entry) => entry.path === sessionPath)
  if (!meta) throw new Error('Source lane is no longer available.')
  if (meta.worktreeRemoved) openSidebarConversation(tree.cwd, meta)
  else await navigateToLane({ sessionId: await sessions.openDiskSession(tree.cwd, meta) })
}

/** Open a lane known only by its pi session id: the sidebar's metadata first, then Brain's reads. */
export async function openBrainLane(sessionId: string): Promise<void> {
  const known = Object.values(useSessionsStore.getState().disk)
    .flat()
    .find((entry) => entry.sessionId === sessionId)?.path
  const path =
    known ??
    (await window.phosphor.invoke('brain:history', 200)).items.find(
      (item) => item.job.sessionId === sessionId,
    )?.job.sessionPath
  if (!path) throw new Error('Source lane is no longer available.')
  await openBrainSource(path)
}
