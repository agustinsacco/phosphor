import { PaneShell, PaneTitle } from '@/components/PaneShell'
import { useEffect, useState } from 'react'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { TooltipButton } from '@/components/Tooltip'
import { hostFeatureRefusal } from '@/stores/hostRefusals'
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
  const refusal = hostFeatureRefusal(host, 'artifacts.read')
  const available = !refusal
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
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
  }, [available, sessionId, summary, epoch, connection, attempt])
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
        {refusal || !failed ? (
          <p className="p-4">{refusal ?? 'Loading artifacts…'}</p>
        ) : (
          <p role="alert" className="p-4">
            Could not read this lane&apos;s artifacts.{' '}
            <TooltipButton onClick={() => setAttempt((n) => n + 1)}>Retry</TooltipButton>
          </p>
        )}
      </PaneShell>
    )
  return <ArtifactsPane sessionId={sessionId} workspacePath={workspacePath} />
}
