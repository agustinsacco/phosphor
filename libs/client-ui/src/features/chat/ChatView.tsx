import { useEffect, useRef } from 'react'
import { useRewindAvailable } from './hostRewind'
import { SessionFileTarget } from '@/features/files/SessionFileTarget'
import { useRemoteLanesStore, readOnlyLane } from '@/stores/remoteLanes'
import { RemoteLaneControls } from '@/features/machines/RemoteLaneControls'
import { LaneLock, useTakenBy } from '@/features/machines/LaneLock'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { ForkPickerModal } from './ForkPickerModal'
import { StatusStrip } from '@/features/extension-ui/StatusStrip'
import { CrashBanner, NoModelsBanner, RewoundBanner } from './banners'
import { HistoryNotice } from './HistoryNotice'

/**
 * The chat column: banners, transcript, composer.
 *
 * It deliberately has no header of its own. Session title, workspace, branch,
 * and the pane switches all live in the window's single top bar
 * (src/app/TopBar.tsx) — a per-column header here could not know whether it was
 * the element sitting under the OS window controls, which is precisely how the
 * right-hand pane's buttons ended up rendering beneath them.
 */
export function ChatView({
  sessionId,
  workspacePath,
  laneControls = 'row',
}: {
  sessionId: string
  workspacePath: string
  /**
   * Where the shell puts a Host lane's control state and actions: a row above the
   * transcript, or the shell's own lane header (the phone's). Either way a
   * reader gets the same locked composer (LaneLock) where it types.
   */
  laneControls?: 'row' | 'header'
}): React.JSX.Element {
  useRemoteLanesStore((s) => s.hosts)
  // A lane whose Host is retrying keeps its composer, locked: it is waiting, not read-only.
  const readOnly = readOnlyLane(sessionId)
  const takenBy = useTakenBy(sessionId)
  const column = useRef<HTMLDivElement>(null)
  // Taking control here hands the keyboard to the composer that replaces the lock.
  const took = useRef(false)
  useEffect(() => {
    if (readOnly || !took.current) return
    took.current = false
    column.current?.querySelector<HTMLTextAreaElement>('textarea.composer-field')?.focus()
  }, [readOnly])
  // A header that carries the controller state and actions would only be repeated by the row.
  const rewindAvailable = useRewindAvailable(sessionId)
  const header = laneControls === 'header'
  return (
    <SessionFileTarget.Provider value={sessionId}>
      <div ref={column} className="flex h-full min-w-0 flex-col">
        <CrashBanner sessionId={sessionId} workspacePath={workspacePath} />
        {!header && <RemoteLaneControls sessionId={sessionId} />}
        <NoModelsBanner sessionId={sessionId} />
        <RewoundBanner sessionId={sessionId} />
        <HistoryNotice sessionId={sessionId} />
        <MessageList sessionId={sessionId} />
        {readOnly ? (
          <LaneLock sessionId={sessionId} takenBy={takenBy} onTaken={() => (took.current = true)} />
        ) : (
          <Composer sessionId={sessionId} workspacePath={workspacePath} />
        )}
        <StatusStrip sessionId={sessionId} />
        {rewindAvailable && <ForkPickerModal sessionId={sessionId} />}
      </div>
    </SessionFileTarget.Provider>
  )
}
