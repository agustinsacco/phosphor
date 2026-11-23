import type { RoutineRun } from '@shared/routines'
import { hostIdOfPath } from '@shared/remote-host'
import { openRemoteLane } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
/**
 * Hand this run's lane back to its workspace, then open it.
 *
 * Opening is the promotion: there is no read-only transcript view in
 * Phosphor — reopening a session file spawns a real pi process — so a lane
 * you have opened is one you own, and it has to be reachable from the
 * sidebar rather than only from this page.
 */
export const openRun = async (run: RoutineRun): Promise<void> => {
  const host = hostIdOfPath(run.id)
  if (host) {
    if (!run.outputLaneId || !(await openRemoteLane(host, run.outputLaneId)))
      throw new Error('The output lane is unavailable on this machine.')
    return
  }
  const store = useSessionsStore.getState()
  if (run.sessionPath) await window.phosphor.invoke('routines:promoteRun', run.id)
  const live = (await window.phosphor.invoke('pi:listLiveSessions')).find(
    (s) => s.sessionId === run.sessionId,
  )
  if (live) {
    await store.adoptSession(live.sessionId, live.workspacePath, run.sessionPath ?? undefined)
    store.activate(live.sessionId)
  } else if (run.sessionPath && run.workspacePath) {
    // A live view may have watched this routine finish and be disposed.
    if (run.sessionId && store.live[run.sessionId]) await store.disposeSession(run.sessionId)
    const sessionId = await store.createSession(run.workspacePath, {
      sessionPath: run.sessionPath,
    })
    store.activate(sessionId)
  } else
    throw new Error(
      'No transcript is available yet. The run may have stopped before pi saved its first message.',
    )
}
