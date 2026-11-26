import clsx from 'clsx'
import { WaitingNote } from '@/components/Waiting'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { hostReady, hostStarting, startingMachine } from '@/stores/hostReadiness'
import { useMachinesStore } from '@/stores/machines'
import {
  canControlSession,
  connectingTo,
  hostReconnecting,
  machineLabel,
  REMOTE_NOT_READY,
  useRemoteLanesStore,
} from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'

/**
 * Why a remote lane's composer is locked. A machine that is starting shows the
 * Phosphor loader; a Host that is retrying spins; both are named. One that stopped
 * says so. Nothing for a local session or a ready Host.
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
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const state = host?.state
  useMachinesStore((s) => s.machines)
  if (!hostId || hostReady(host)) return null
  if (hostStarting(host))
    return (
      <p
        role="status"
        className={clsx('text-text-secondary flex items-center gap-2 text-sm', className)}
      >
        <PhosphorLoader size={20} decorative />
        <span>{startingMachine(machineLabel(hostId))}</span>
      </p>
    )
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
 * typed while it starts or retries could be sent, so the field waits, draft visible.
 */
export function useRemoteLock(sessionId: string): { disabled: boolean; 'aria-busy'?: true } {
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  const hostId = target?.kind === 'remote' ? target.hostId : ''
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const waiting = !!hostId && (hostReconnecting(host?.state) || hostStarting(host))
  return { disabled: !canControlSession(sessionId), 'aria-busy': waiting || undefined }
}
