import { useSessionsStore } from '@/stores/sessions'
import { sessionHostLane, useRemoteLanesStore, REMOTE_UNAVAILABLE } from '@/stores/remoteLanes'
import { laneFilePath, type RevealTarget } from '@/stores/files'
let sequence = 0
import { useRemoteFileSelection } from './remoteFileSelectionStore'
export { useRemoteFileSelection, releaseRemoteFileSelection } from './remoteFileSelectionStore'
export async function openRemoteFile(
  sessionId: string,
  path: string,
  target?: number | RevealTarget,
): Promise<void> {
  const session = useSessionsStore.getState().live[sessionId]
  const remote = sessionHostLane(sessionId)
  if (!session || !remote) throw new Error(REMOTE_UNAVAILABLE)
  const { host, lane } = remote
  if (
    !lane ||
    host?.state !== 'ready' ||
    !host.capabilities.includes('workspaces.read') ||
    useRemoteFileSelection.getState().blocked[sessionId]
  )
    throw new Error(REMOTE_UNAVAILABLE)
  const relative = laneFilePath(lane.cwd, session.workspacePath, path).slice(
    session.workspacePath.length + 1,
  )
  await window.phosphor.invoke('fs:readFile', `${session.workspacePath}/${relative}`)
  if (
    useSessionsStore.getState().live[sessionId] !== session ||
    useRemoteLanesStore.getState().hosts[remote.hostId] !== host ||
    useRemoteFileSelection.getState().blocked[sessionId]
  )
    throw new Error(REMOTE_UNAVAILABLE)
  useRemoteFileSelection.setState((s) => ({
    bySession: {
      ...s.bySession,
      [sessionId]: {
        path: relative,
        ...(target === undefined
          ? {}
          : {
              reveal: {
                ...(typeof target === 'number' ? { line: target } : target),
                seq: ++sequence,
              },
            }),
      },
    },
  }))
}
