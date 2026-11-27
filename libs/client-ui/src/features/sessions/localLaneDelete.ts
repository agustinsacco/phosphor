import { useBrain } from '@/features/brain/useBrain'
import { create } from 'zustand'
import type { SessionMeta } from '@shared/models'
import { laneMarker } from '@/lib/laneMarker'
import { sessionTitle } from '@/lib/sessionTitle'
import { useChatStore } from '@/stores/chat'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { localLanePrs } from './useLanePrs'
import { useSessionsStore } from '@/stores/sessions'
import type { DeleteSessionTarget } from './DeleteSessionModal'
import { liveByDiskPath } from './groupSessions'
import {
  classifyLane,
  lanesOwningWorktree,
  summarizePreflight,
  type PreflightSummary,
} from './deletePreflight'

/** This Mac's open delete confirm: the lane confirm, or the transcript-only one. */
export const useLocalLaneDelete = create<{
  lanes: PreflightSummary | null
  session: DeleteSessionTarget | null
}>(() => ({ lanes: null, session: null }))

export function confirmLaneDelete(lanes: PreflightSummary | null): void {
  useLocalLaneDelete.setState({ lanes })
}

export function confirmSessionDelete(session: DeleteSessionTarget | null): void {
  useLocalLaneDelete.setState({ session })
}

/**
 * Build the confirm's preflight at click time rather than per render.
 *
 * Reads every store through `getState()` on purpose: the streaming flag and
 * the live session name are only needed at the moment the user asks to
 * delete, and subscribing every row to them would re-render the sidebar on
 * every token.
 */
export function buildLaneDelete(paths: string[], workspacePath: string): PreflightSummary {
  const chat = useChatStore.getState()
  const sessions = useSessionsStore.getState()
  const markerPrefMode = useLanePrefsStore.getState().lanes.markers
  const allMetas = Object.values(sessions.disk).flat()
  const metaByPath = new Map(allMetas.map((meta) => [meta.path, meta] as const))
  const liveByDisk = liveByDiskPath(sessions.live)
  // A worktree goes only with the last session using it.
  const owners = lanesOwningWorktree(
    paths.flatMap((path) => {
      const meta = metaByPath.get(path)
      return meta ? [{ path, cwd: meta.cwd || workspacePath }] : []
    }),
    [
      ...allMetas.map((m) => ({ path: m.path, cwd: m.cwd || workspacePath })),
      ...Object.values(sessions.live).map((l) => ({ path: l.diskPath, cwd: l.workspacePath })),
    ],
  )

  const lanes = paths.flatMap((path) => {
    const meta = metaByPath.get(path)
    if (!meta) return []
    const livePhosphorId = liveByDisk.get(path)
    const git = sessions.gitByCwd[meta.cwd || workspacePath]
    const liveName = livePhosphorId ? chat.sessions[livePhosphorId]?.meta?.sessionName : undefined
    const explicit = sessions.laneMarkers[path]
    return [
      classifyLane({
        meta,
        title:
          sessionTitle({
            explicitName: liveName ?? meta.name,
            firstUserText: meta.firstUserText,
          }) ?? 'Untitled session',
        marker: laneMarker(
          explicit,
          git?.branch,
          meta.cwd,
          markerPrefMode,
          useBrain.getState().status?.agent.folder,
        ),
        git,
        pr: localLanePrs(meta, git).owned[0]?.pr,
        isLive: Boolean(livePhosphorId),
        isStreaming: livePhosphorId ? (chat.sessions[livePhosphorId]?.isStreaming ?? false) : false,
        ownsWorktree: owners.has(path),
      }),
    ]
  })
  return summarizePreflight(lanes)
}

/**
 * A single row's Archive: the archive confirm for this one session. The
 * conversation and its worktree stay on disk; the row leaves the sidebar.
 */
export function archiveLocalRow(meta: SessionMeta, title: string, workspacePath: string): void {
  confirmSessionDelete({
    title,
    path: meta.path,
    workspacePath: meta.cwd || workspacePath,
    archive: true,
  })
}
