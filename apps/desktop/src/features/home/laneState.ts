import type { GhPullRequest, GitInfo, SessionMeta } from '@shared/models'
import { sessionTitle } from '@/lib/sessionTitle'

/**
 * The workbench's lane classification: what each lane needs from you.
 * The urgency groups drive the headline; tiles retain their own spatial order.
 *
 * Everything here is derived from state the renderer already holds: the disk
 * scan, `gitByCwd`, the PR store, the dialog store and the chat store. No
 * cross-session observer in main, so this is correct with zero live sessions
 * and after a restart.
 */
export type LaneState = 'blocked' | 'ready' | 'attention' | 'review' | 'running'

/**
 * Urgency order for summaries, not tile positions or classification priority:
 * running wins over PR state in `classifyLane` but ranks last here.
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
  meta: Pick<
    SessionMeta,
    'path' | 'cwd' | 'name' | 'firstUserText' | 'cost' | 'lastActivityAt' | 'mtimeMs'
  >
  git?: GitInfo
  pr?: GhPullRequest
  /** This lane's live session id, when it has one. */
  phosphorId?: string
  isStreaming: boolean
  /** Current-session async roots/descendants, or an explicitly incomplete snapshot. */
  hasDelegatedWork?: boolean
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
  if (checks === null) return false
  if (!checks || checks.total === 0) return true
  return checks.failed === 0 && checks.pending === 0
}

function laneIdentity({ meta, git, pr, phosphorId }: LaneInput) {
  return {
    path: meta.path,
    ...(phosphorId ? { phosphorId } : {}),
    title:
      sessionTitle({ explicitName: meta.name, firstUserText: meta.firstUserText }) ?? 'Untitled',
    ...(git?.branch ? { branch: git.branch } : {}),
    workspacePath: meta.cwd,
    ...(pr ? { pr } : {}),
    cost: meta.cost,
    lastActivityAt: Date.parse(meta.lastActivityAt) || meta.mtimeMs,
  }
}

/** Questions beat streaming, which beats PR state. No match means idle, not success. */
export function classifyLane(input: LaneInput): BoardLane | null {
  const { git, pr } = input
  const base = laneIdentity(input)
  if (input.hasPendingQuestion) {
    return { ...base, state: 'blocked', detail: 'asked you a question', action: 'answer' }
  }
  if (input.isStreaming || input.hasDelegatedWork) {
    return {
      ...base,
      state: 'running',
      detail: input.isStreaming ? 'working now' : 'delegated work in progress',
      action: 'open',
    }
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
    // Checks are pending or unavailable: neither is proof it is ready.
    return {
      ...base,
      state: 'review',
      detail:
        pr.state === 'DRAFT'
          ? 'draft'
          : pr.checks === null
            ? 'checks unavailable'
            : 'checks running',
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

export type WorkbenchLane = Omit<BoardLane, 'state'> & { state: LaneState | 'idle' }

export interface LaneBoard {
  /** Includes idle lanes so a completed task keeps a tile and can be reopened. */
  lanes: WorkbenchLane[]
  columns: Record<LaneState, BoardLane[]>
  /** Lanes with no active work or outstanding PR/branch action. */
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
  const lanes: WorkbenchLane[] = []
  for (const input of inputs) {
    const lane = classifyLane(input)
    lanes.push(
      lane ?? {
        ...laneIdentity(input),
        state: 'idle',
        detail: 'No active work reported',
        action: 'open',
      },
    )
    if (!lane) {
      idleCount += 1
      continue
    }
    columns[lane.state].push(lane)
  }
  for (const state of LANE_STATES) {
    columns[state].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }
  return { columns, idleCount, lanes }
}

interface LanePosition {
  key: string
  path: string
  phosphorId?: string
}

/** Keep tile identity across first save, suspend/resume and status changes. */
export function retainLaneOrder(
  previous: LanePosition[],
  current: WorkbenchLane[],
): LanePosition[] {
  const byPath = new Map(current.map((lane) => [lane.path, lane]))
  const byLive = new Map(
    current.filter((lane) => lane.phosphorId).map((lane) => [lane.phosphorId, lane]),
  )
  const remaining = new Set(current)
  const next: LanePosition[] = []
  for (const position of previous) {
    const lane =
      byPath.get(position.path) ??
      (position.phosphorId ? byLive.get(position.phosphorId) : undefined)
    if (lane && remaining.delete(lane))
      next.push({ ...position, path: lane.path, phosphorId: lane.phosphorId })
  }
  // Initial placement puts actionable work ahead of history. Once placed,
  // status and recency never move it; later arrivals append as a batch.
  const rank = (lane: WorkbenchLane): number =>
    lane.state === 'idle' ? LANE_STATES.length : LANE_STATES.indexOf(lane.state)
  for (const lane of [...remaining].sort(
    (a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt,
  ))
    next.push({ key: lane.phosphorId ?? lane.path, path: lane.path, phosphorId: lane.phosphorId })
  return next.length === previous.length &&
    next.every(
      (p, i) =>
        p.key === previous[i]?.key &&
        p.path === previous[i]?.path &&
        p.phosphorId === previous[i]?.phosphorId,
    )
    ? previous
    : next
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
