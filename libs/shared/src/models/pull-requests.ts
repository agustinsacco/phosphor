import type { GhBranchCoverage, GhPullRequest } from './git'

/** One pull request, wherever it lives. Owner and repo keep GitHub's casing. */
export interface GhPrRef {
  host: string
  owner: string
  repo: string
  number: number
}

/** `github.com/goaugment/augment-services#20246`: lowercased, so casing never splits a PR in two. */
export type GhPrKey = string

/**
 * Pull requests a lane's session file points at, folded by the session scan
 * from the lane's own entries and from its subagent runs. Only `opened`,
 * `branches` and `pinned` make a PR part of the lane; the rest are suggestions.
 */
export interface LanePrSignals {
  /** URLs printed by a `gh pr create` the lane (or one of its subagents) ran. */
  opened: GhPrRef[]
  /** Branches the lane created or pushed, looked up through branch discovery. */
  branches: string[]
  /** PRs the lane checked out, diffed or reviewed. */
  reviewing: GhPrRef[]
  /** The same, by bare number (`gh pr diff 123`): in the lane's own repository. */
  reviewingHere?: number[]
  /** PR links in prompts and replies. */
  mentioned: GhPrRef[]
  /** Added through "Track a PR…", stored in the session file. */
  pinned: GhPrRef[]
  /** Removed from the lane through "Hide", stored in the session file. */
  hidden: GhPrRef[]
}

export type GhPrCheckState = 'failure' | 'pending' | 'success' | 'neutral' | 'skipped'

/** One check run or commit status on the PR's head commit. */
export interface GhPrCheck {
  name: string
  state: GhPrCheckState
  /** Required by branch protection for this PR's base branch. */
  required: boolean
  /** A check run's own summary line, e.g. "1 unresolved finding". */
  title?: string
  url?: string
}

export interface GhPrReviewer {
  name: string
  team: boolean
  codeOwner: boolean
}

/** Everything a pill, a chip and the inspector's overview need, read by number. */
export interface GhPrSummary extends GhPullRequest {
  ref: GhPrRef
  headRefName: string
  baseRefName: string
  additions: number
  deletions: number
  changedFiles: number
  comments: number
  updatedAt: string
  mergedAt?: string
  closedAt?: string
  author?: string
  headSha?: string
  /** null when GitHub could not list them; then nothing may read as passing. */
  checkRuns: GhPrCheck[] | null
  /** More than 100 contexts: the list and counts are partial. */
  checksTruncated: boolean
  approvedBy: string[]
  changesRequestedBy: string[]
  /** Pending review requests, code owners first. */
  waitingOn: GhPrReviewer[]
  /** null when there are more than 100 threads. */
  threads: { total: number; unresolved: number } | null
  inMergeQueue: boolean
  autoMerge: boolean
}

/** A bounded read by number. `absent` only when GitHub says the PR does not exist. */
export interface GhPrRead {
  byKey: Record<GhPrKey, GhPrSummary>
  coverage: Record<GhPrKey, GhBranchCoverage>
}

export interface GhPrSummaryOptions {
  force?: boolean
}

/** An unresolved review thread, as the inspector lists it. */
export interface GhPrThread {
  path: string
  line?: number
  /** The code it commented on has changed since. */
  outdated: boolean
  author?: string
  /** The first comment as plain text, cut to 500 characters. */
  body: string
  /** Comments after the first. */
  replies: number
  url?: string
}

/** One line of a check run's output: why it failed, when the run says. */
export interface GhPrAnnotation {
  path: string
  line?: number
  level: 'failure' | 'warning' | 'notice'
  message: string
}

export interface GhPrCheckDetail extends GhPrCheck {
  workflow?: string
  startedAt?: string
  completedAt?: string
  /** The run's first three annotations. */
  annotations: GhPrAnnotation[]
}

export type GhPrEventKind =
  'review' | 'commit' | 'force-push' | 'requested' | 'ready' | 'merged' | 'closed' | 'reopened'

/** One timeline item: who did what, when. */
export interface GhPrEvent {
  kind: GhPrEventKind
  /** ISO time. */
  at: string
  actor?: string
  /** A review's state: APPROVED, CHANGES_REQUESTED, COMMENTED or DISMISSED. */
  state?: string
  /** A commit's headline, or who was asked to review. */
  text?: string
}

/** What the inspector shows beyond the summary: read for one PR, while it is open. */
export interface GhPrDetail {
  ref: GhPrRef
  /** Unresolved threads in file order, at most 30. */
  threads: GhPrThread[]
  /** There are more unresolved threads than these. */
  threadsTruncated: boolean
  /** null when GitHub could not list them. */
  checks: GhPrCheckDetail[] | null
  checksTruncated: boolean
  /** Reviewers whose latest review only commented. */
  commented: string[]
  /** The last 20 timeline items, oldest first. */
  activity: GhPrEvent[]
  /** When this was read from GitHub. */
  checkedAt: number
}
