import clsx from 'clsx'
import { WaitingNote } from '@/components/Waiting'
import { useMachinesStore } from '@/stores/machines'
import {
  canControlSession,
  connectingTo,
  hostReconnecting,
  REMOTE_NOT_READY,
  useRemoteLanesStore,
} from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'

/**
 * Why a remote lane's composer is locked. A Host that is retrying spins and is
 * named; one that stopped says so. Nothing for a local session or a ready Host.
 */
export function HostWaitNote({
  sessionId,
  className,
}: {
  sessionId: string
  className?: string
}): React.JSX.Element | null {
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  const hostId = target?.kind === 'remote' ? target.hostId : ''
  const state = useRemoteLanesStore((s) => s.hosts[hostId]?.state)
  useMachinesStore((s) => s.machines)
  if (!hostId || state === 'ready') return null
  if (hostReconnecting(state))
    return <WaitingNote className={className}>{connectingTo(hostId, state)}</WaitingNote>
  return (
    <p role="status" className={clsx('text-sm', className)}>
      {REMOTE_NOT_READY}
    </p>
  )
}

/**
 * The composer's lock. Only a held lane on a ready Host takes input: nothing
 * typed while it retries could be sent, so the field waits, draft visible.
 */
export function useRemoteLock(sessionId: string): { disabled: boolean; 'aria-busy'?: true } {
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  const hostId = target?.kind === 'remote' ? target.hostId : ''
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const waiting = !!hostId && hostReconnecting(host?.state)
  return { disabled: !canControlSession(sessionId), 'aria-busy': waiting || undefined }
}
