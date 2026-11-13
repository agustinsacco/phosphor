import { parsePrUrl, prKey } from '@shared/github-pr-refs'
import type {
  GhBranchCoverage,
  GhPrKey,
  GhPrRef,
  GhPrSummary,
  GhPullRequest,
  LanePrSignals,
} from '@shared/models'
import type { RepoPullRequests } from '@/stores/pullRequests'
import type { PrStatusEntry } from '@/stores/prStatus'
import { prVerdict, type PrVerdict } from './prVerdict'

/** Why a PR belongs to a lane, strongest first. */
export type LanePrSource = 'opened' | 'branch' | 'checkout' | 'pinned'

export const SOURCE_LABEL: Record<LanePrSource, string> = {
  opened: 'Opened in this lane',
  branch: 'From a branch this lane pushed',
  checkout: 'This worktree’s branch',
  pinned: 'Tracked by you',
}

export interface LanePr {
  key: GhPrKey
  /** Absent when discovery's URL names no repository: shown, never read by number. */
  ref?: GhPrRef
  number: number
  source?: LanePrSource
  /** The by-number summary when read, else what branch discovery saw, else nothing yet. */
  pr?: GhPullRequest | GhPrSummary
  coverage?: GhBranchCoverage
  /** The last read failed: what is shown may be old. */
  stale: boolean
  verdict: PrVerdict
}

export interface LanePrs {
  /** The lane's own PRs, the one that needs you most first. */
  owned: LanePr[]
  /** PRs the lane checked out, diffed or reviewed. */
  reviewing: LanePr[]
  /** Linked from a prompt or reply; one click tracks them. */
  mentioned: LanePr[]
  /** `owner/repo` this lane's checkout belongs to, when discovery has seen one of its PRs. */
  home?: Omit<GhPrRef, 'number'>
}

export const NO_LANE_PRS: LanePrs = Object.freeze({
  owned: [],
  reviewing: [],
  mentioned: [],
}) as unknown as LanePrs

const refOf = (pr: GhPullRequest | undefined): GhPrRef | null => (pr ? parsePrUrl(pr.url) : null)

/**
 * Discovery reads one repository: every PR it found lives there, which is
 * also the repository a bare `gh pr diff 123` in this checkout meant.
 */
export function homeRepo(slice: RepoPullRequests): LanePrs['home'] {
  for (const pr of Object.values(slice.byBranch)) {
    const ref = refOf(pr)
    if (ref) return { host: ref.host, owner: ref.owner, repo: ref.repo }
  }
  return undefined
}

export interface LanePrInput {
  signals?: LanePrSignals
  /** The worktree's checked-out branch. */
  branch?: string
  slice: RepoPullRequests
  status: Record<GhPrKey, PrStatusEntry>
}

export function resolveLanePrs({ signals, branch, slice, status }: LanePrInput): LanePrs {
  const hidden = new Set((signals?.hidden ?? []).map(prKey))
  const discovered = new Map<GhPrKey, GhPullRequest>()
  const owned = new Map<GhPrKey, { ref?: GhPrRef; source: LanePrSource; number: number }>()
  const own = (ref: GhPrRef | null, source: LanePrSource, pr?: GhPullRequest) => {
    const key = ref ? prKey(ref) : pr ? `url:${pr.url}` : null
    if (!key) return
    if (pr) discovered.set(key, pr)
    const number = ref?.number ?? pr!.number
    if (!hidden.has(key) && !owned.has(key))
      owned.set(key, { ref: ref ?? undefined, source, number })
  }
  for (const ref of signals?.opened ?? []) own(ref, 'opened')
  for (const name of signals?.branches ?? []) {
    const pr = slice.byBranch[name]
    if (pr) own(refOf(pr), 'branch', pr)
  }
  const checkout = branch ? slice.byBranch[branch] : undefined
  if (checkout) own(refOf(checkout), 'checkout', checkout)
  for (const ref of signals?.pinned ?? []) own(ref, 'pinned')

  const item = (key: GhPrKey, number: number, ref?: GhPrRef, source?: LanePrSource): LanePr => {
    const entry = ref ? status[key] : undefined
    const pr = entry?.summary ?? discovered.get(key)
    const stale = !!entry?.failed || entry?.coverage?.state === 'unavailable'
    return {
      key,
      ref,
      number,
      source,
      pr,
      coverage: entry?.coverage,
      stale,
      verdict: prVerdict(pr),
    }
  }
  const exists = (lane: LanePr) => lane.coverage?.state !== 'absent'
  const ownedItems = [...owned]
    .map(([key, { ref, source, number }]) => item(key, number, ref, source))
    .filter(exists)
    .sort(compareLanePrs)

  const home = homeRepo(slice)
  const taken = new Set([...owned.keys(), ...hidden])
  const others = (refs: GhPrRef[]) =>
    refs.flatMap((ref) => {
      const key = prKey(ref)
      if (taken.has(key)) return []
      taken.add(key)
      return [item(key, ref.number, ref)]
    })
  const here = home ? (signals?.reviewingHere ?? []).map((number) => ({ ...home, number })) : []
  const reviewing = others([...(signals?.reviewing ?? []), ...here]).filter(exists)
  const mentioned = others(signals?.mentioned ?? []).filter(exists)
  return { owned: ownedItems, reviewing, mentioned, home }
}

/** Most urgent first; then the most recently updated; then the newest. */
export function compareLanePrs(a: LanePr, b: LanePr): number {
  const updated = (lane: LanePr) => (lane.pr && 'updatedAt' in lane.pr ? lane.pr.updatedAt : '')
  return (
    a.verdict.rank - b.verdict.rank || updated(b).localeCompare(updated(a)) || b.number - a.number
  )
}

/**
 * Refs to read by number. Rows and pills read only the lane's own PRs;
 * suggestions are read while the inspector shows them.
 */
export function laneStatusRefs(prs: LanePrs, all = false): GhPrRef[] {
  return (all ? [...prs.owned, ...prs.reviewing, ...prs.mentioned] : prs.owned).flatMap((lane) =>
    lane.ref ? [lane.ref] : [],
  )
}
