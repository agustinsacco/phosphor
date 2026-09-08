import { create } from 'zustand'
import type { GhPullRequest } from '@shared/models'
import { keyedSlice } from './keyedSlice'

/**
 * Pull-request state per repo, projected from the `gh` CLI.
 *
 * Keyed by repo path rather than by session: a sidebar group is one repo (the
 * grouping already folds worktrees into their main checkout), and one
 * `gh:prsForRepo` call answers for every lane in it. A lane's PR is then joined
 * at render time through `gitByCwd[cwd].branch`, the same way the subtitle
 * already joins git info — `SessionMeta` has no branch field to hang this on.
 *
 * Every failure mode of `gh` is a normal state, not an error: not installed,
 * not authenticated, no GitHub remote. Those all land here as an empty map and
 * render as no chip. Nothing in this store surfaces a toast.
 */
export interface RepoPullRequests {
  /** headRefName → PR. Empty when gh is unavailable or the repo has none. */
  byBranch: Record<string, GhPullRequest>
  /** Epoch ms of the last completed refresh; 0 when never fetched. */
  fetchedAt: number
  /** A refresh is in flight — used to collapse concurrent triggers. */
  loading: boolean
}

const repos = keyedSlice<RepoPullRequests>({ byBranch: {}, fetchedAt: 0, loading: false })

/** How stale a repo's PR map may be before an event-driven refresh refetches. */
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
    if (!opts.force && current.fetchedAt > 0 && Date.now() - current.fetchedAt < PR_STALE_MS) return

    let available = get().available
    if (available === undefined) {
      available = await window.phosphor.invoke('gh:available')
      set({ available })
    }
    // No gh, no chips, no noise — and no repeated probe: the main-process
    // side caches its own answer for the process lifetime.
    if (!available) return

    set((s) => ({ byRepo: repos.patch(s.byRepo, repoPath, (r) => ({ ...r, loading: true })) }))
    let byBranch: Record<string, GhPullRequest> = {}
    try {
      byBranch = await window.phosphor.invoke('gh:prsForRepo', repoPath)
    } catch {
      // Handler already swallows gh's own failures; this catches IPC teardown
      // during shutdown. Keep the previous map rather than blanking the chips.
      set((s) => ({ byRepo: repos.patch(s.byRepo, repoPath, (r) => ({ ...r, loading: false })) }))
      return
    }
    set((s) => ({
      byRepo: repos.patch(s.byRepo, repoPath, () => ({
        byBranch,
        fetchedAt: Date.now(),
        loading: false,
      })),
    }))
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
