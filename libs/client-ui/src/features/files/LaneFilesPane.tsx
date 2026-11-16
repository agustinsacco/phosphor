import { useSessionsStore } from '@/stores/sessions'
import { FilesPane } from './FilesPane'
import { useLaneFilesSource } from './filesSource'

/**
 * A browser lane's Files: Desktop's Files pane over the lane's files source. The Host reads only
 * the focused lane and focus follows activation, which can land after this pane mounts, so it
 * waits for its lane to be active, then reads.
 */
export function LaneFilesPane({
  sessionId,
  workspacePath,
}: {
  sessionId: string
  workspacePath: string
}): React.JSX.Element {
  const active = useSessionsStore((s) => s.activeSessionId === sessionId)
  const source = useLaneFilesSource(sessionId, workspacePath)
  if (!active)
    return (
      <p role="status" className="p-4">
        Opening lane…
      </p>
    )
  return <FilesPane source={source} />
}
