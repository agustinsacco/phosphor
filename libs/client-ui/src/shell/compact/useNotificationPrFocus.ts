import { useEffect } from 'react'
import { isPrRef, prKey } from '@phosphor/shared/github-pr-refs'
import { useNavigation } from '@/navigation/Navigation'
import { useSessionsStore } from '@/stores/sessions'
import { usePrInspectorStore } from '@/stores/prInspector'

/** A notification may open a lane on one PR; consume that request only after this lane is active. */
export function useNotificationPrFocus(): void {
  const { location } = useNavigation()
  const session = useSessionsStore((s) =>
    s.activeSessionId ? s.live[s.activeSessionId] : undefined,
  )
  useEffect(() => {
    if (
      location.to !== 'lane' ||
      !('hostId' in location.lane) ||
      session?.target?.kind !== 'remote' ||
      session.target.hostId !== location.lane.hostId ||
      session.laneId !== location.lane.laneId
    )
      return
    const url = new URL(window.location.href)
    const raw = url.searchParams.get('notificationPr')
    if (!raw) return
    url.searchParams.delete('notificationPr')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
    try {
      const ref: unknown = JSON.parse(raw)
      if (isPrRef(ref)) usePrInspectorStore.getState().open(session.phosphorId, prKey(ref))
    } catch {
      /* Untrusted/malformed query parameters never open an inspector. */
    }
  }, [location, session])
}
