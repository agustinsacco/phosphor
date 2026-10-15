import { PaneShell, PaneTitle } from '@/components/PaneShell'
import { useEffect, useState } from 'react'
import { useRemoteLanesStore, REMOTE_UNAVAILABLE } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { refreshRemoteArtifacts } from './remoteArtifactRefresh'
import { MachineChip } from '@/features/machines/RemoteLaneControls'
import { ArtifactsPane } from './ArtifactsPane'

export function RemoteArtifactsPane({
  sessionId,
  workspacePath,
}: {
  sessionId: string
  workspacePath: string
}): React.JSX.Element {
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  const host = useRemoteLanesStore((s) =>
    target?.kind === 'remote' ? s.hosts[target.hostId] : undefined,
  )
  const laneId = useSessionsStore((s) => s.live[sessionId]?.laneId)
  const summary = JSON.stringify(host?.lanes.find((l) => l.laneId === laneId))
  const available = host?.state === 'ready' && host.capabilities.includes('artifacts.read')
  const [failed, setFailed] = useState(false)
  // The session whose Host list has loaded at least once while available. Later refreshes
  // (turn ends, reconnects, epoch changes) replace the list in place and keep the viewer
  // mounted, so a pinned version survives them. Only a lane switch or losing the Host
  // returns to the loading shell, which keeps another lane's artifacts from showing.
  const [loaded, setLoaded] = useState<string | null>(null)
  const epoch = host?.cursor?.epoch
  const connection = host?.connectionToken
  useEffect(() => {
    let alive = true
    setFailed(false)
    if (!available) setLoaded(null)
    else
      void refreshRemoteArtifacts(sessionId)
        .then((applied) => {
          if (alive) {
            if (applied) setLoaded(sessionId)
            else setFailed(true)
          }
        })
        .catch(() => {
          if (alive) setFailed(true)
        })
    return () => {
      alive = false
    }
  }, [available, sessionId, summary, epoch, connection])
  if (!available || failed || loaded !== sessionId)
    return (
      <PaneShell
        title={
          <>
            <PaneTitle label="Artifacts" />
            <MachineChip sessionId={sessionId} />
          </>
        }
      >
        <p className="p-4">{!available || failed ? REMOTE_UNAVAILABLE : 'Loading artifacts…'}</p>
      </PaneShell>
    )
  return <ArtifactsPane sessionId={sessionId} workspacePath={workspacePath} />
}
