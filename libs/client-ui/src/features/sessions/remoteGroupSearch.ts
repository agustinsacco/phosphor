import { useMemo, useState } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { remotePrKey } from '@shared/host-protocol-github'
import { useChatStore } from '@/stores/chat'
import { repoPullRequests, usePullRequestsStore } from '@/stores/pullRequests'
import { useSessionsStore } from '@/stores/sessions'
import { laneHaystack, laneMatches, laneQueryTerms } from './laneSearch'
import { sessionTitle } from '@/lib/sessionTitle'

/**
 * A Host folder's lane search: the draft being typed, the applied query and the
 * lanes it keeps. A lane matches as This Mac's do (`laneSearch.ts`): by its
 * title (the live name first), its branch, or its pull request's number and title.
 */
export function useRemoteGroupSearch(hostId: string, repositoryId: string, lanes: HostLaneView[]) {
  const [searching, setSearching] = useState(false)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const terms = laneQueryTerms(query)
  const prs = usePullRequestsStore((s) => repoPullRequests(s, remotePrKey(hostId, repositoryId)))
  const liveNames = useLiveLaneNames(hostId, terms.length > 0)
  return {
    searching,
    draft,
    query,
    visible: terms.length
      ? lanes.filter((lane) =>
          laneMatches(
            laneHaystack({
              title:
                sessionTitle(
                  { explicitName: liveNames.get(lane.laneId) ?? lane.title },
                  { elide: false },
                ) ?? '',
              branch: lane.branch ?? undefined,
              pr: lane.branch ? prs.byBranch[lane.branch] : undefined,
            }),
            terms,
          ),
        )
      : lanes,
    setDraft,
    open: () => setSearching(true),
    commit: () => setQuery(draft),
    clear: () => {
      setSearching(false)
      setDraft('')
      setQuery('')
    },
  }
}

/**
 * Live session names of this Host's open lanes, by lane, while a filter is on:
 * they lead the Host summary, so a lane renamed a moment ago is found under the
 * name its row shows. Subscribed as a joined string, as the local sidebar does,
 * so streaming re-renders nothing.
 */
function useLiveLaneNames(hostId: string, active: boolean): Map<string, string> {
  const live = useSessionsStore((s) => s.live)
  const key = useChatStore((s) =>
    active
      ? Object.values(live)
          .flatMap((entry) =>
            entry.target?.kind === 'remote' && entry.target.hostId === hostId && entry.laneId
              ? [`${entry.laneId}\u0000${s.sessions[entry.phosphorId]?.meta?.sessionName ?? ''}`]
              : [],
          )
          .join('\u0001')
      : '',
  )
  return useMemo(
    () =>
      new Map(
        key
          .split('\u0001')
          .map((entry) => entry.split('\u0000') as [string, string])
          .filter(([, name]) => !!name),
      ),
    [key],
  )
}
