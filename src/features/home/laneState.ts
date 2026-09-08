import type { GhPullRequest, GitInfo, SessionMeta } from '@shared/models'
import { sessionTitle } from '@/lib/sessionTitle'

/**
 * The home screen's lane board: what each lane needs from you, not when it
 * last spoke.
 *
 * The sidebar sorts by recency, which is the one ordering that never answers
 * "what do I do next" — a lane whose checks went green an hour ago sinks below
 * one that printed a log line a minute ago. These columns are ordered by the
 * action they imply instead, and a lane appears in exactly one of them.
 *
 * Everything here is derived from state the renderer already holds: the disk
 * scan, `gitByCwd`, the PR store, the dialog store and the chat store. No
 * cross-session observer in main, so this is correct with zero live sessions
 * and after a restart.
 */
export type LaneState = 'blocked' | 'ready' | 'attention' | 'review' | 'running'

/**
 * Column order on screen: most urgent first, so the leftmost thing is the
 * thing to do. This is NOT the classification order — `classifyLane` decides
 * that, and the two are deliberately different (a running lane sorts last here
 * but wins over PR state there).
 */
export const LANE_STATES: readonly LaneState[] = [
  'blocked',
  'ready',
  'attention',
  'review',
  'running',
]

export const LANE_STATE_LABEL: Record<LaneState, string> = {
  blocked: 'Waiting on you',
  ready: 'Ready to merge',
  attention: 'Needs a push',
  review: 'In review',
  running: 'Running',
}

/** The one thing the card's button does. `open` is the fallback. */
export type LaneAction = 'answer' | 'merge' | 'update' | 'open'

export interface BoardLane {
  /** Session file path — the identity the sidebar and the stores agree on. */
  path: string
  /** Live session id, when this lane has a process. */
  phosphorId?: string
  title: string
  branch?: string
  workspacePath: string
  state: LaneState
  /** One short phrase saying why it landed in this column. */
  detail: string
  action: LaneAction
  pr?: GhPullRequest
  cost: number
  lastActivityAt: number
}

export interface LaneInput {
  meta: SessionMeta
  git?: GitInfo
  pr?: GhPullRequest
  /** This lane's live session id, when it has one. */
  phosphorId?: string
  isStreaming: boolean
  /** The live session is holding a question the user has not answered. */
  hasPendingQuestion: boolean
}

/**
 * Are this PR's checks green?
 *
 * `undefined` checks means gh reported no rollup at all (no CI on the repo),
 * which is not the same as "passing" — but for a merge decision it is the same
 * answer the GitHub UI gives, so a repo with no CI can still reach `ready`.
 * A single pending check is enough to hold a lane back: half-green is a state
 * that resolves itself, and offering Merge during it invites a race.
 */
export function checksGreen(pr: GhPullRequest): boolean {
  const checks = pr.checks
  if (!checks || checks.total === 0) return true
  return checks.failed === 0 && checks.pending === 0
}

/**
 * Which column a lane belongs in, and why.
 *
 * Order matters and is deliberate: a question beats everything (you are the
 * only one who can clear it), streaming beats PR state (the answer is "wait"),
 * and a red build beats being behind main (fix it before you rebase it).
 * A lane matching nothing is idle and is not a card at all.
 */
export function classifyLane(input: LaneInput): BoardLane | null {
  const { meta, git, pr } = input
  const base = {
    path: meta.path,
    ...(input.phosphorId ? { phosphorId: input.phosphorId } : {}),
    title:
      sessionTitle({ explicitName: meta.name, firstUserText: meta.firstUserText }) ?? 'Untitled',
    ...(git?.branch ? { branch: git.branch } : {}),
    workspacePath: meta.cwd,
    ...(pr ? { pr } : {}),
    cost: meta.cost,
    lastActivityAt: Date.parse(meta.lastActivityAt) || meta.mtimeMs,
  }

  if (input.hasPendingQuestion) {
    return { ...base, state: 'blocked', detail: 'asked you a question', action: 'answer' }
  }
  if (input.isStreaming) {
    return { ...base, state: 'running', detail: 'working now', action: 'open' }
  }

  if (pr && (pr.state === 'OPEN' || pr.state === 'DRAFT')) {
    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      return { ...base, state: 'attention', detail: 'changes requested', action: 'open' }
    }
    const failed = pr.checks?.failed ?? 0
    if (failed > 0) {
      return {
        ...base,
        state: 'attention',
        detail: `${failed} check${failed > 1 ? 's' : ''} failing`,
        action: 'open',
      }
    }
    if (pr.state === 'OPEN' && checksGreen(pr)) {
      const approved = pr.reviewDecision === 'APPROVED'
      return {
        ...base,
        state: 'ready',
        detail: approved ? 'approved, checks green' : 'checks green',
        action: 'merge',
      }
    }
    // An open PR that is neither mergeable nor broken is still in flight, and
    // dropping it off the board entirely is how a lane goes quiet on you: a
    // pending check resolves on its own, and you want to know it is close.
    // Reaching here with an OPEN PR means checks are pending: a failing one
    // was caught above, and a green one is already `ready`.
    return {
      ...base,
      state: 'review',
      detail: pr.state === 'DRAFT' ? 'draft' : 'checks running',
      action: 'open',
    }
  }

  // No PR to judge, so the remaining question is whether the branch has
  // drifted. Only worktree lanes are offered an update: a session in the main
  // checkout has no branch of its own to rebase.
  const behind = git?.behind ?? 0
  if (behind > 0 && git?.isWorktree) {
    return {
      ...base,
      state: 'attention',
      detail: `${behind} behind main`,
      action: 'update',
    }
  }

  return null
}

export interface LaneBoard {
  columns: Record<LaneState, BoardLane[]>
  /** Lanes that matched no column — idle, nothing to do. Counted, not shown. */
  idleCount: number
}

/**
 * Group lanes into columns, most recently active first inside each.
 *
 * Recency is the right *secondary* sort even though it is the wrong primary
 * one: within "ready to merge", the thing you just finished is the thing you
 * mean to land.
 */
export function buildLaneBoard(inputs: LaneInput[]): LaneBoard {
  const columns: Record<LaneState, BoardLane[]> = {
    blocked: [],
    ready: [],
    attention: [],
    review: [],
    running: [],
  }
  let idleCount = 0
  for (const input of inputs) {
    const lane = classifyLane(input)
    if (!lane) {
      idleCount += 1
      continue
    }
    columns[lane.state].push(lane)
  }
  for (const state of LANE_STATES) {
    columns[state].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }
  return { columns, idleCount }
}

/** The board's one-line headline, in the order a reader should care. */
export function boardHeadline(board: LaneBoard): string | null {
  const { blocked, ready, attention, review, running } = board.columns
  if (blocked.length > 0) return `${blocked.length} waiting on you`
  if (ready.length > 0) return `${ready.length} ready to merge`
  if (attention.length > 0) {
    return `${attention.length} need${attention.length > 1 ? '' : 's'} a push`
  }
  if (review.length > 0) return `${review.length} in review`
  if (running.length > 0) return `${running.length} running`
  return null
}
