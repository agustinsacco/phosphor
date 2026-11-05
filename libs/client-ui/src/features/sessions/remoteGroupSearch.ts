import { useState } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { remotePrKey } from '@shared/host-protocol-github'
import { repoPullRequests, usePullRequestsStore } from '@/stores/pullRequests'
import { useSessionsStore } from '@/stores/sessions'
import { laneHaystack, laneMatches, laneQueryTerms } from './laneSearch'
import { useLiveSessionNames } from './useLiveSessionNames'
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
  const live = useSessionsStore((s) => s.live)
  // This Host's open lanes, by lane id: their live names lead the Host summary.
  const liveNames = useLiveSessionNames(terms.length > 0, (sessionId) => {
    const entry = live[sessionId]
    return entry?.target?.kind === 'remote' && entry.target.hostId === hostId
      ? entry.laneId
      : undefined
  })
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
