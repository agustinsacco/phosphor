import type { useSessionsStore } from '@/stores/sessions'

type LiveEntry = ReturnType<typeof useSessionsStore.getState>['live'][string]

/** This computer's own live sessions, without the Host lanes open in this window. */
export function localLiveEntries(live: Record<string, LiveEntry>): LiveEntry[] {
  return Object.values(live).filter((entry) => entry.target?.kind !== 'remote')
}
