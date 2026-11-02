import { useEffect, useState } from 'react'
import type { HostConnectionView } from '@shared/ipc'
import type { StartingChat } from '@/stores/startingChat'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'

/** How long one step may show before the echo says it is slow. */
export const SLOW_START_MS = 12_000

/**
 * The one line under a starting chat: which step it is on, and where.
 *
 * A Host start reads its step from the hosts snapshot. No entry means the request
 * has not reached the connection yet or its receipt is already in; an entry
 * without a phase means the Host has not answered yet. Both are honest waits,
 * not errors. The entry is matched by repository: a composer claims its draft, so
 * one window has at most one creation in flight per repository from it.
 */
export function startingLabel(
  starting: StartingChat,
  host: HostConnectionView | undefined,
  machine: string,
): string {
  const remote = starting.remote
  if (!remote) return starting.phase === 'branching' ? 'Creating branch…' : 'Starting session…'
  if (remote.sessionId) return 'Sending your message…'
  if (host?.state !== 'ready') return `Reconnecting to ${machine}…`
  const start = host.laneStarts?.filter((s) => s.repositoryId === remote.repositoryId).at(-1)
  switch (start?.phase) {
    case 'queued':
      return `Waiting for ${machine} to finish starting another lane…`
    case 'branching':
      return `Creating branch on ${machine}…`
    case 'starting':
      return `Starting session on ${machine}…`
    case 'prompting':
      return 'Sending your message…'
    default:
      return start ? `Waiting for ${machine}…` : `Starting a lane on ${machine}…`
  }
}

/** The step label, and a second line once one step has outlasted `SLOW_START_MS`. */
export function useStartingStatus(starting: StartingChat): { label: string; slow: string | null } {
  const hostId = starting.remote?.hostId
  const host = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId] : undefined))
  const machine = hostId ? machineLabel(hostId) : ''
  const label = startingLabel(starting, host, machine)
  const [slowLabel, setSlowLabel] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setSlowLabel(label), SLOW_START_MS)
    // A step that comes back later starts its own wait, not the old one's.
    return () => {
      clearTimeout(timer)
      setSlowLabel(null)
    }
  }, [label])
  if (slowLabel !== label) return { label, slow: null }
  return {
    label,
    slow: hostId
      ? `${machine} is slow to answer. Your draft stays until the lane has your message.`
      : 'This is taking longer than usual.',
  }
}
