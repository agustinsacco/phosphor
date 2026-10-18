export interface GitInfo {
  isRepo: boolean
  branch?: string
  ahead?: number
  behind?: number
  dirtyCount?: number
  /** True when the cwd is a linked git worktree (git-dir ≠ common-dir). */
  isWorktree?: boolean
  /** The main repository's working directory, when this is a worktree. */
  mainRepoPath?: string
}

/** One entry from `git worktree list`, enriched with dirty state. */
export interface WorktreeInfo {
  /** Path as git recorded it at `worktree add` time. */
  path: string
  /** `realpathSync.native`-resolved path — matches session cwds. */
  realPath: string
  branch: string | null
  head: string
  isMain: boolean
  locked: boolean
  prunable: boolean
  /** `git status --porcelain` line count; −1 when the dir is missing. */
  dirtyCount: number
}

export interface BranchInfo {
  name: string
  isCurrent: boolean
  /** Worktree that has this branch checked out, if any. */
  worktreePath?: string
  lastCommitSubject?: string
  lastCommitAt?: number
  /** Upstream ref (`origin/main`), absent when the branch never had one. */
  upstream?: string
  /** Commits this branch has that its upstream does not. */
  ahead?: number
  /** Commits the upstream has that this branch does not — "out of date". */
  behind?: number
  /**
   * Commits the repo's default branch has that this one does not. Absent when
   * git is too old for `%(ahead-behind:)` (< 2.41), which the UI treats the
   * same as "unknown", never as zero.
   */
  behindDefault?: number
}

export type AddWorktreeBranch =
  | {
      kind: 'new'
      base: string
      /**
       * Branch to create, when it must differ from the worktree folder name.
       * Auto-created session branches carry a configurable prefix (`phosphor/…`)
       * that cannot appear in the folder name — the folder's basename is what
       * names the sidebar group, and a `/` in it would nest the checkout.
       * Absent means "same as the folder name", the hand-created case.
       */
      branch?: string
      /**
       * Skip `git`'s automatic upstream setup. Set when `base` is a
       * remote-tracking ref: without it the new branch would take `origin/main`
       * as its upstream, so its ahead/behind counts would be measured against
       * trunk and a stray `git push` would aim at main.
       */
      noTrack?: boolean
    }
  | { kind: 'existing'; branch: string }

/**
 * Where a new session branch should start from: the freshest trunk this repo
 * can offer without touching the main tree's checkout.
 */
export interface StartPoint {
  /** Ref to branch from — `origin/main` when fetched, else local `main`. */
  base: string
  /** Trunk's local branch name (`main`, `master`, …). */
  defaultBranch: string
  /** True when `base` is a remote-tracking ref (implies `noTrack` on create). */
  fromRemote: boolean
}

/** `git fetch --prune`, which is allowed to be a no-op or to fail quietly. */
export type FetchResult =
  | { fetched: true; at: number }
  /** Skipped: a fetch for this repo already ran inside the throttle window. */
  | { fetched: false; reason: 'throttled'; at: number }
  /** Offline, no remote, or no credentials — all ordinary, never an error. */
  | { fetched: false; reason: 'failed'; message: string }

/** Fast-forward-only pull. Never writes a merge commit, never conflicts. */
export type PullResult =
  | { pulled: true; upstream: string; commits: number }
  | { pulled: false; reason: 'up-to-date'; upstream: string }
  | { pulled: false; reason: 'no-upstream' }
  | { pulled: false; reason: 'diverged'; upstream: string; ahead: number; behind: number }
  | { pulled: false; reason: 'dirty'; dirtyCount: number }

/** Merging trunk into a worktree branch. Conflicts abort, never linger. */
export type UpdateFromMainResult =
  | { updated: true; commits: number; sha: string }
  | { updated: false; reason: 'up-to-date' }
  | { updated: false; reason: 'dirty'; dirtyCount: number }
  | { updated: false; reason: 'conflict'; conflicts: string[] }

/** Checking a branch out in a working tree, guarded on dirty/held. */
export type CheckoutResult =
  | { checkedOut: true; branch: string }
  | { checkedOut: false; reason: 'dirty'; dirtyCount: number }
  | { checkedOut: false; reason: 'held'; worktreePath: string }

/** Summary of a PR's status checks, from `gh` statusCheckRollup. */
export interface GhChecks {
  passed: number
  failed: number
  pending: number
  total: number
}

/**
 * A pull request for the current branch, as reported by the `gh` CLI.
 * Absent (null) whenever gh is missing, unauthenticated, or the repo has no
 * GitHub remote — all normal states, never surfaced as errors.
 */
export interface GhRepoPullRequests {
  byBranch: Record<string, GhPullRequest>
  /** False when the bounded listing may have omitted older branches. */
  complete: boolean
}

export interface GhPullRequest {
  number: number
  title: string
  state: 'OPEN' | 'DRAFT' | 'CLOSED' | 'MERGED'
  url: string
  mergeable?: string
  mergeStateStatus?: string
  /** null when check details could not be fetched; undefined when there are no checks. */
  checks?: GhChecks | null
  /**
   * Review verdict. Distinct from `checks`: a PR can be fully green and still
   * blocked on a human, which is a different action for the reader than a red
   * build, so the sidebar chip renders the two differently.
   */
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'
}
