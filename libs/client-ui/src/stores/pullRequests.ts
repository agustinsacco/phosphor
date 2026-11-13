import { create } from 'zustand'
import type { GhBranchCoverage, GhPullRequest } from '@shared/models'
import { pullRequestInterests } from './pullRequestInterests'
import { mergePullRequestRead, pullRequestPages } from './pullRequestReads'
import { keyedSlice } from './keyedSlice'

/**
 * Pull-request state per repo, projected from the `gh` CLI.
 *
 * Keyed by repo path rather than by session: a sidebar group is one repo (the
 * grouping already folds worktrees into their main checkout). Bounded targeted
 * reads progressively cover the interested lane branches. A lane's PR is then joined
 * at render time through `gitByCwd[cwd].branch`, the same way the subtitle
 * already joins git info — `SessionMeta` has no branch field to hang this on.
 *
 * Every failure mode of `gh` is a normal state, not an error: not installed,
 * not authenticated, no GitHub remote. Failures preserve known PRs but cannot
 * confirm absence. Nothing in this store surfaces a toast.
 */
export interface RepoPullRequests {
  /** headRefName → PR from the last successful fetch. */
  byBranch: Record<string, GhPullRequest>
  coverage?: Record<string, GhBranchCoverage>
  /** App scheduling, separate from the upstream observation/attempt timestamps. */
  branchAttemptedAt?: Record<string, number>
  /** Epoch ms of the last successful app refresh (not upstream freshness); 0 when never fetched. */
  fetchedAt: number
  /** Never set or read: kept only because a frozen characterization fixture spells it. */
  complete?: boolean
  /** Last app attempt failed; known PRs remain available. */
  failed?: boolean
  /** Last attempt, including failures, for retry throttling. */
  attemptedAt: number
  /** A refresh is in flight — used to collapse concurrent triggers. */
  loading: boolean
}

const repos = keyedSlice<RepoPullRequests>({
  byBranch: {},
  fetchedAt: 0,
  attemptedAt: 0,
  loading: false,
  failed: false,
})

/** Minimum interval between automatic app refresh attempts for a repo. */
export const PR_STALE_MS = 60_000

interface PullRequestsState {
  /** repoPath → that repo's PRs. */
  byRepo: Record<string, RepoPullRequests>
  /** Cached `gh:available` probe; undefined until first asked. */
  available: boolean | undefined

  refresh: (repoPath: string, opts?: { force?: boolean }) => Promise<void>
  remove: (repoPath: string) => void
}

export const usePullRequestsStore = create<PullRequestsState>((set, get) => ({
  byRepo: {},
  available: undefined,

  /**
   * Refetch one repo. Cheap to call from anywhere: it no-ops while a fetch is
   * in flight, and within `PR_STALE_MS` unless forced. That is what lets the
   * focus / group-expand / turn-end triggers all call it without coordinating.
   */
  refresh: async (repoPath, opts = {}) => {
    if (!repoPath) return
    const current = repos.read(get().byRepo, repoPath)
    if (current.loading) return
    if (!opts.force && current.attemptedAt > 0 && Date.now() - current.attemptedAt < PR_STALE_MS)
      return

    set((s) => ({
      byRepo: repos.patch(s.byRepo, repoPath, (r) => ({
        ...r,
        loading: true,
        failed: false,
        attemptedAt: Date.now(),
      })),
    }))
    let pending = get().byRepo[repoPath]!
    const pages = pullRequestPages(pullRequestInterests(repoPath), current)
    // No known heads yet: retain bounded legacy discovery (also used by old Hosts).
    if (!pages.length) pages.push([])
    for (const branches of pages) {
      let result = null
      try {
        let available = repoPath.startsWith('host:') ? true : get().available
        if (available === undefined || available === false) {
          available = await window.phosphor.invoke('gh:available')
          set({ available })
        }
        if (get().byRepo[repoPath] !== pending) return
        if (available)
          result = branches.length
            ? await window.phosphor.invoke('gh:prsForRepo', repoPath, {
                branches,
                ...(opts.force ? { force: true } : {}),
              })
            : await window.phosphor.invoke('gh:prsForRepo', repoPath)
      } catch {
        /* A failed page cannot invalidate another branch's chip. */
      }
      if (get().byRepo[repoPath] !== pending) return
      set((s) => ({
        byRepo: repos.patch(s.byRepo, repoPath, (r) =>
          mergePullRequestRead(r, result, branches, Date.now()),
        ),
      }))
      pending = get().byRepo[repoPath]!
      // A legacy reply already covers its whole bounded listing. Don't repeat it per page.
      if (result && !result.coverage) break
    }
    if (get().byRepo[repoPath] !== pending) return
    set((s) => ({ byRepo: repos.patch(s.byRepo, repoPath, (r) => ({ ...r, loading: false })) }))
  },

  remove: (repoPath) =>
    set((s) => {
      if (!(repoPath in s.byRepo)) return s
      const next = { ...s.byRepo }
      delete next[repoPath]
      return { byRepo: next }
    }),
}))

/**
 * A repo's PR slice. Returns the shared frozen empty value for an unknown
 * repo — never inline a fresh `{}` here, it re-renders every subscriber.
 */
export function repoPullRequests(
  state: Pick<PullRequestsState, 'byRepo'>,
  repoPath: string | null | undefined,
): RepoPullRequests {
  return repos.read(state.byRepo, repoPath)
}

/** The PR for one lane, or undefined. `branch` comes from the lane's GitInfo. */
export function pullRequestFor(
  state: Pick<PullRequestsState, 'byRepo'>,
  repoPath: string | null | undefined,
  branch: string | null | undefined,
): GhPullRequest | undefined {
  if (!branch) return undefined
  return repos.read(state.byRepo, repoPath).byBranch[branch]
}

// A This Mac lane's PRs: `localLanePrs` and `useLocalLanePrs` in `features/sessions/useLanePrs.ts`.
