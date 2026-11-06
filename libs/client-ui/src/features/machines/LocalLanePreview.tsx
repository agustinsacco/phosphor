import { useMemo } from 'react'
import { errorText } from '@shared/errors'
import type { SessionMeta } from '@shared/models'
import { sessionTitle } from '@/lib/sessionTitle'
import { useNavigation } from '@/navigation/Navigation'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSessionsStore } from '@/stores/sessions'
import { openSidebarConversation } from '@/features/sessions/completionActions'
import { pendingLiveEntries } from '@/features/sessions/groupSessions'
import { sessionSubtitle } from '@/features/sessions/sessionSubtitle'
import { LaneRow, SessionIndicator, SubtitleSegments } from '@/features/sessions/SidebarPrimitives'
import { isUnseen } from '@/features/sessions/unseen'
import { localLiveEntries } from './localLive'

/** A This Mac lane: its file (once pi has written one), its live session, or both. */
export interface LocalLane {
  key: string
  workspacePath: string
  meta?: SessionMeta
  phosphorId?: string
}

/** This Mac's lanes the sessions store knows, newest first: live ones before their first file. */
export function useLocalLanes(): LocalLane[] {
  const disk = useSessionsStore((s) => s.disk)
  const live = useSessionsStore((s) => s.live)
  return useMemo(() => {
    const local = localLiveEntries(live)
    const liveByPath = new Map(local.map((entry) => [entry.diskPath, entry.phosphorId]))
    const stored = Object.entries(disk)
      .flatMap(([workspacePath, metas]) => metas.map((meta) => ({ workspacePath, meta })))
      .sort((a, b) => (b.meta.mtimeMs ?? 0) - (a.meta.mtimeMs ?? 0))
    const paths = new Set(stored.map(({ meta }) => meta.path))
    return [
      ...pendingLiveEntries(local, paths).map((entry) => ({
        key: entry.phosphorId,
        workspacePath: entry.workspacePath,
        phosphorId: entry.phosphorId,
      })),
      ...stored.map(({ workspacePath, meta }) => ({
        key: meta.path,
        workspacePath,
        meta,
        phosphorId: liveByPath.get(meta.path),
      })),
    ]
  }, [disk, live])
}

/**
 * A This Mac lane in the machine preview: the Host row's content (state dot,
 * title, time, branch) on the same `LaneRow`. It opens the lane; the sidebar
 * row's menu is not here yet.
 */
export function LocalLanePreviewRow({ lane }: { lane: LocalLane }): React.JSX.Element {
  const { navigate } = useNavigation()
  const { meta, phosphorId } = lane
  const streaming = useChatStore((s) =>
    phosphorId ? s.sessions[phosphorId]?.isStreaming === true : false,
  )
  const liveName = useChatStore((s) =>
    phosphorId ? s.sessions[phosphorId]?.meta?.sessionName : undefined,
  )
  const firstUser = useChatStore((s) => {
    const item = phosphorId ? s.sessions[phosphorId]?.items.find((i) => i.kind === 'user') : null
    return item?.kind === 'user' ? item.text : undefined
  })
  const unseen = useSessionsStore((s) =>
    meta ? isUnseen(s.seenSessions, meta.path, meta.lastActivityAt) : false,
  )
  const git = useSessionsStore((s) => s.gitByCwd[meta?.cwd ?? lane.workspacePath])
  const title =
    sessionTitle(
      { explicitName: liveName ?? meta?.name, firstUserText: meta?.firstUserText ?? firstUser },
      { elide: false },
    ) ?? (meta ? 'Untitled session' : 'New session')
  const open = async (): Promise<void> => {
    if (!phosphorId && meta?.worktreeRemoved)
      return openSidebarConversation(lane.workspacePath, meta)
    try {
      const sessionId =
        phosphorId ?? (await useSessionsStore.getState().openDiskSession(lane.workspacePath, meta!))
      navigate({ to: 'lane', lane: { sessionId } })
    } catch (error) {
      useExtensionUiStore.getState().pushToast(errorText(error), 'error')
    }
  }
  return (
    <LaneRow
      tooltip={title}
      aria-label={title}
      className="hover:bg-sidebar-hover"
      onClick={() => void open()}
    >
      <SessionIndicator
        state={streaming ? 'streaming' : unseen ? 'unseen' : phosphorId ? 'live' : 'disk'}
      />
      <span className="min-w-0 flex-1">
        <span className="text-text block truncate text-lg font-medium leading-5">{title}</span>
        <span className="text-text-secondary flex items-center gap-1 text-base leading-4">
          <SubtitleSegments
            segments={sessionSubtitle(meta ?? {}, git)}
            activity={streaming ? 'working' : undefined}
          />
        </span>
      </span>
    </LaneRow>
  )
}
