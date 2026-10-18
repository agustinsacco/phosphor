/**
 * Matching for the sidebar's per-workspace lane search.
 *
 * A lane is found by whichever of its three identities the reader remembers:
 * the title Phosphor gave it, the branch it runs on, or the PR it became. So the
 * haystack is all three, and a query term may land in any of them.
 *
 * Substring, not subsequence. `lib/fuzzy.ts` is a subsequence matcher, and on
 * branch-shaped text a three-letter query matches nearly every lane — which
 * reads as a filter that did nothing. Terms are ANDed and order-free, so
 * `130 rebase` and `rebase 130` find the same lane.
 *
 * Pure and React-free; `Sidebar.tsx` is the only consumer.
 */

import type { GhPullRequest } from '@shared/models'

/** What one lane offers the matcher. Everything but the title is optional. */
export interface LaneSearchFields {
  title: string
  branch?: string
  pr?: Pick<GhPullRequest, 'number' | 'title'>
}

/**
 * Lowercase, and every run of non-alphanumerics becomes one space.
 *
 * That is what makes `#412` findable as `412`, and
 * `phosphor/fix-and-rebase-pr-130` findable as `fix rebase`, without the caller
 * knowing which separator a branch happens to use.
 */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** The query, as normalized terms. Empty when nothing is worth matching. */
export function laneQueryTerms(raw: string): string[] {
  const normalized = normalize(raw)
  return normalized ? normalized.split(' ') : []
}

/** The searchable text for one lane, normalized once per render. */
export function laneHaystack(fields: LaneSearchFields): string {
  const parts = [fields.title, fields.branch ?? '']
  if (fields.pr) parts.push(String(fields.pr.number), fields.pr.title)
  return normalize(parts.join(' '))
}

/** True when every term appears somewhere in the lane's text. */
export function laneMatches(haystack: string, terms: string[]): boolean {
  return terms.every((term) => haystack.includes(term))
}
