import { create } from 'zustand'
import { isFilePath } from '@shared/host-protocol-files'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore, REMOTE_UNAVAILABLE } from '@/stores/remoteLanes'
import type { PendingReveal, RevealTarget } from '@/stores/files'
let sequence = 0
export const useRemoteFileSelection = create<{
  bySession: Record<string, { path: string; reveal?: PendingReveal }>
  blocked: Record<string, boolean>
}>(() => ({ bySession: {}, blocked: {} }))
export function remoteRelativePath(root: string, workspace: string, path: string): string {
  if (path.startsWith('host:') && !path.startsWith(`${workspace}/`))
    throw new Error(REMOTE_UNAVAILABLE)
  const relative = path.startsWith(`${workspace}/`)
    ? path.slice(workspace.length + 1)
    : path.startsWith('/')
      ? path.startsWith(`${root}/`)
        ? path.slice(root.length + 1)
        : null
      : path
  if (!isFilePath(relative)) throw new Error(REMOTE_UNAVAILABLE)
  return relative
}
export async function openRemoteFile(
  sessionId: string,
  path: string,
  target?: number | RevealTarget,
): Promise<void> {
  const session = useSessionsStore.getState().live[sessionId]
  if (session?.target?.kind !== 'remote') throw new Error(REMOTE_UNAVAILABLE)
  const host = useRemoteLanesStore.getState().hosts[session.target.hostId]
  const lane = host?.lanes.find((l) => l.laneId === session.laneId)
  if (
    !lane ||
    host?.state !== 'ready' ||
    !host.capabilities.includes('workspaces.read') ||
    useRemoteFileSelection.getState().blocked[sessionId]
  )
    throw new Error(REMOTE_UNAVAILABLE)
  const relative = remoteRelativePath(lane.cwd, session.workspacePath, path)
  await window.phosphor.invoke('fs:readFile', `${session.workspacePath}/${relative}`)
  if (
    useSessionsStore.getState().live[sessionId] !== session ||
    useRemoteLanesStore.getState().hosts[session.target.hostId] !== host ||
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
export function releaseRemoteFileSelection(sessionId: string): void {
  useRemoteFileSelection.setState((s) => {
    const bySession = { ...s.bySession },
      blocked = { ...s.blocked }
    delete bySession[sessionId]
    delete blocked[sessionId]
    return { bySession, blocked }
  })
}
