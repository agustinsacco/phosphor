import clsx from 'clsx'
import { WaitingNote } from '@/components/Waiting'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { startingMachine } from '@/stores/hostReadiness'
import { retryMachineStart, useHostPhase } from '@/stores/machineStartLimit'
import { Button } from '@/components/form'
import { useMachinesStore } from '@/stores/machines'
import {
  canControlSession,
  connectingTo,
  machineLabel,
  REMOTE_NOT_READY,
  useRemoteLanesStore,
} from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'

/**
 * Why a remote lane's composer is locked. A machine that is starting shows the
 * Phosphor loader, until its time limit (`MACHINE_START_LIMIT_MS`); a Host that is
 * retrying spins; both are named. One that stopped says so, with Retry when This
 * Mac's start ran out of time. Nothing for a local session or a ready Host.
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
  const phase = useHostPhase(hostId)
  useMachinesStore((s) => s.machines)
  if (!hostId || phase === 'ready') return null
  if (phase === 'starting')
    return (
      <p
        role="status"
        className={clsx('text-text-secondary flex items-center gap-2 text-sm', className)}
      >
        <PhosphorLoader size={20} decorative />
        <span>{startingMachine(machineLabel(hostId))}</span>
      </p>
    )
  if (phase === 'connecting')
    return <WaitingNote className={className}>{connectingTo(hostId, state)}</WaitingNote>
  // Still `ready` here only when This Mac's boot window ran out: offer a fresh one.
  return (
    <p role="status" className={clsx('flex items-center gap-2 text-sm', className)}>
      <span>{REMOTE_NOT_READY}</span>
      {host?.local && state === 'ready' && (
        <Button size="xs" onClick={() => void retryMachineStart(hostId).catch(() => undefined)}>
          Retry
        </Button>
      )}
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
  const phase = useHostPhase(hostId || undefined)
  const waiting = !!hostId && (phase === 'connecting' || phase === 'starting')
  return { disabled: !canControlSession(sessionId), 'aria-busy': waiting || undefined }
}
