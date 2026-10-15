import { useEffect, useState } from 'react'
import { useRemoteLanesStore, REMOTE_UNAVAILABLE } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useArtifactsStore } from '@/stores/artifacts'
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
  const [loaded, setLoaded] = useState<string | null>(null)
  const epoch = host?.cursor?.epoch
  const connection = host?.connectionToken
  const requestKey = JSON.stringify([sessionId, summary, epoch, connection])
  useEffect(() => {
    let alive = true
    setLoaded(null)
    setFailed(false)
    if (available)
      void window.phosphor
        .invoke('artifacts:forSession', sessionId)
        .then((items) => {
          if (alive) {
            useArtifactsStore.getState().hydrate(sessionId, items)
            setLoaded(requestKey)
          }
        })
        .catch(() => {
          if (alive) setFailed(true)
        })
    return () => {
      alive = false
    }
  }, [available, sessionId, summary, epoch, connection, requestKey])
  if (!available || loaded !== requestKey)
    return <p className="p-4">{!available || failed ? REMOTE_UNAVAILABLE : 'Loading artifacts…'}</p>
  return <ArtifactsPane sessionId={sessionId} workspacePath={workspacePath} />
}
