import { useState } from 'react'
import { laneHaystack, laneMatches, laneQueryTerms, type LaneSearchFields } from './laneSearch'

export interface GroupSearch {
  searching: boolean
  draft: string
  query: string
  /**
   * A query is applied. Until then nothing is filtered, so a group subscribes
   * to what its lanes are found by (live names, pull requests) only once true.
   */
  applied: boolean
  /** The lanes the applied query keeps, matched by their identities (`laneSearch.ts`). */
  filter: <T>(lanes: T[], fields: (lane: T) => LaneSearchFields) => T[]
  setDraft: (draft: string) => void
  open: () => void
  commit: () => void
  /** Retract the filter and close the bar. The two are never separable. */
  clear: () => void
}

/**
 * A lane group's search, on any machine: the draft being typed and the applied
 * query. Draft and applied are separate because Enter commits
 * (`LaneSearchBar`). Neither persists: a filter that survived a restart would
 * open on a list missing most of its lanes.
 */
export function useGroupSearch(): GroupSearch {
  const [searching, setSearching] = useState(false)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const terms = laneQueryTerms(query)
  return {
    searching,
    draft,
    query,
    applied: terms.length > 0,
    filter: (lanes, fields) =>
      terms.length ? lanes.filter((lane) => laneMatches(laneHaystack(fields(lane)), terms)) : lanes,
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
