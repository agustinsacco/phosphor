import { useEffect, useState } from 'react'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

/** Home browsing belongs to the switcher, never the last active lane. */
export function useMachineHomeFiles(): {
  hostId: string | null
  open: boolean
  toggle: () => void
} {
  const filter = useRemoteLanesStore((s) => s.filter)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const hostId = !activeSessionId && filter !== 'local' && filter !== 'all' ? filter : null
  const [openedHost, setOpenedHost] = useState<string | null>(null)
  useEffect(() => setOpenedHost(null), [filter, activeSessionId])
  return {
    hostId,
    open: hostId !== null && openedHost === hostId,
    toggle: () => setOpenedHost((current) => (current === hostId ? null : hostId)),
  }
}
