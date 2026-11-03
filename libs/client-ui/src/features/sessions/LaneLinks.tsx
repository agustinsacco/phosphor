import { LanePrStatus } from './LanePrStatus'
import { LaneSlackThreads } from './LaneSlackThreads'
import { useRemoteLaneSession } from './useRemoteLaneActions'

/** The lane header's quick links: its pull request, then the Slack threads it mentions. */
export function LaneLinks({ sessionId }: { sessionId: string }): React.JSX.Element {
  return (
    <>
      <LanePrStatus sessionId={sessionId} />
      <LaneSlackThreads sessionId={sessionId} />
    </>
  )
}

/** Browser routes identify lanes before their session is adopted. */
export function RemoteLaneLinks({
  hostId,
  laneId,
}: {
  hostId: string
  laneId: string
}): React.JSX.Element | null {
  const session = useRemoteLaneSession(hostId, laneId)
  return session ? <LaneLinks sessionId={session.phosphorId} /> : null
}
