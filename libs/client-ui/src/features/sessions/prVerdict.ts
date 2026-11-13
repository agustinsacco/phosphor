import type { GhPrCheck, GhPrSummary, GhPullRequest } from '@shared/models'

/**
 * What one pull request needs from you, in one word, one line and one colour.
 * Every PR surface reads this: the header pill, the sidebar beads, the
 * inspector and the Home board, so they can never disagree.
 *
 * Status read by branch discovery alone has no per-check detail; then this
 * says less rather than guess. Unknown or partial checks never read as green.
 */
export type PrTone =
  | 'failing'
  | 'conflict'
  | 'blocked'
  | 'pending'
  | 'review'
  | 'ready'
  | 'draft'
  | 'merged'
  | 'closed'
  | 'unknown'

export type PrBlockerKind = 'checks' | 'conflict' | 'changes' | 'running' | 'threads' | 'review'

export interface PrBlocker {
  kind: PrBlockerKind
  text: string
  rank: number
}

export interface PrVerdict {
  tone: PrTone
  /** 0 needs you most. Orders a lane's PRs and picks the one its pill leads with. */
  rank: number
  word: string
  headline: string
  blockers: PrBlocker[]
}

type AnyPr = GhPullRequest | GhPrSummary
export const isSummary = (pr: AnyPr | undefined): pr is GhPrSummary => !!pr && 'checkRuns' in pr

export interface CheckFacts {
  /** null: GitHub did not say, so nothing may read as passing. */
  known: boolean
  total: number
  failing: GhPrCheck[]
  /** Failures in order, without per-check detail when only counts are known. */
  failed: number
  requiredFailed: number | null
  pending: number
  requiredPending: number | null
}

export function checkFacts(pr: AnyPr): CheckFacts {
  const runs = isSummary(pr) ? pr.checkRuns : null
  if (runs && !(isSummary(pr) && pr.checksTruncated)) {
    const failing = runs.filter((c) => c.state === 'failure')
    const pending = runs.filter((c) => c.state === 'pending')
    return {
      known: true,
      total: runs.length,
      failing,
      failed: failing.length,
      requiredFailed: failing.filter((c) => c.required).length,
      pending: pending.length,
      requiredPending: pending.filter((c) => c.required).length,
    }
  }
  const counts = pr.checks
  // GitHub's merge state says when only non-required checks fail.
  const optionalOnly = pr.mergeStateStatus === 'UNSTABLE'
  return {
    known: !!counts,
    total: counts?.total ?? 0,
    failing: runs?.filter((c) => c.state === 'failure') ?? [],
    failed: counts?.failed ?? 0,
    requiredFailed: optionalOnly ? 0 : null,
    pending: counts?.pending ?? 0,
    requiredPending: null,
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const people = (names: string[]) => names.map((n) => `@${n}`).join(', ')

export function prBlockers(pr: AnyPr): PrBlocker[] {
  const summary = isSummary(pr) ? pr : undefined
  const checks = checkFacts(pr)
  const blockers: PrBlocker[] = []
  if (pr.mergeable === 'CONFLICTING')
    blockers.push({
      kind: 'conflict',
      text: `Conflicts with ${summary?.baseRefName || 'its base'}`,
      rank: 1,
    })
  if (checks.failed) {
    const optional = checks.requiredFailed === 0
    const only = checks.failing.length === 1 ? checks.failing[0]!.name : undefined
    blockers.push(
      optional
        ? {
            kind: 'checks',
            text: only
              ? `${only} failed (not required)`
              : `${plural(checks.failed, 'optional check')} failed`,
            rank: 3,
          }
        : {
            kind: 'checks',
            text: checks.requiredFailed
              ? `${plural(checks.requiredFailed, 'required check')} failing`
              : `${plural(checks.failed, 'check')} failing`,
            rank: 0,
          },
    )
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || summary?.changesRequestedBy.length)
    blockers.push({
      kind: 'changes',
      text: summary?.changesRequestedBy.length
        ? `Changes requested by ${people(summary.changesRequestedBy)}`
        : 'Changes requested',
      rank: 2,
    })
  if (checks.pending)
    blockers.push({ kind: 'running', text: `Checks running, ${checks.pending} left`, rank: 4 })
  if (summary?.threads?.unresolved)
    blockers.push({
      kind: 'threads',
      text: plural(summary.threads.unresolved, 'unresolved thread'),
      rank: 5,
    })
  const owners = summary?.waitingOn.filter((r) => r.codeOwner) ?? []
  if (pr.reviewDecision !== 'APPROVED' && owners.length)
    blockers.push({
      kind: 'review',
      text: `Waiting on code owners ${people(owners.map((o) => o.name))}`,
      rank: 5,
    })
  return blockers.sort((a, b) => a.rank - b.rank)
}

const WORD: Partial<Record<PrBlockerKind, [PrTone, string]>> = {
  conflict: ['conflict', 'Conflict'],
  checks: ['failing', 'Failing'],
  changes: ['blocked', 'Changes'],
  running: ['pending', 'Running'],
  threads: ['pending', 'Threads'],
  review: ['review', 'In review'],
}

export function prVerdict(pr: AnyPr | undefined): PrVerdict {
  if (!pr)
    return { tone: 'unknown', rank: 10, word: 'Loading', headline: 'Reading status…', blockers: [] }
  if (pr.state === 'MERGED')
    return { tone: 'merged', rank: 8, word: 'Merged', headline: 'Merged', blockers: [] }
  if (pr.state === 'CLOSED')
    return {
      tone: 'closed',
      rank: 9,
      word: 'Closed',
      headline: 'Closed without merging',
      blockers: [],
    }
  const blockers = prBlockers(pr)
  if (pr.state === 'DRAFT') {
    const failing = blockers.find((b) => b.kind === 'checks' && b.rank === 0)
    return {
      tone: 'draft',
      rank: 7,
      word: 'Draft',
      headline: failing ? `Draft · ${failing.text}` : 'Draft',
      blockers,
    }
  }
  const top = blockers[0]
  if (top) {
    const [tone, word] = WORD[top.kind]!
    return { tone, rank: top.rank, word, headline: top.text, blockers }
  }
  const checks = checkFacts(pr)
  // No CI is not green CI: an empty rollup never reads as ready (known issue R1).
  const ran = checks.known && checks.total > 0
  if (pr.reviewDecision === 'APPROVED' && ran) {
    const queued = isSummary(pr) && pr.inMergeQueue
    return {
      tone: 'ready',
      rank: 6,
      word: 'Ready',
      headline: queued ? 'In the merge queue' : 'Approved, checks green: ready to merge',
      blockers,
    }
  }
  const headline =
    pr.reviewDecision !== 'APPROVED'
      ? 'Waiting for review'
      : checks.known
        ? 'Approved; no checks reported'
        : 'Approved; checks unknown'
  return { tone: 'review', rank: 5, word: 'In review', headline, blockers }
}

/** What GitHub would actually block a merge on. Optional checks and open threads don't, alone. */
export function mergeBlock(pr: AnyPr): string | null {
  if (pr.state !== 'OPEN') return pr.state === 'DRAFT' ? 'it is a draft' : null
  const summary = isSummary(pr) ? pr : undefined
  const checks = checkFacts(pr)
  if (pr.mergeable === 'CONFLICTING') return `conflicts with ${summary?.baseRefName || 'its base'}`
  if (checks.requiredFailed || (checks.failed && checks.requiredFailed === null))
    return 'required checks failing'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested'
  if (checks.requiredPending) return 'required checks still running'
  if (pr.reviewDecision === 'REVIEW_REQUIRED')
    return summary?.waitingOn.some((r) => r.codeOwner)
      ? 'needs a code-owner review'
      : 'needs an approving review'
  if (checks.pending) return 'checks still running'
  if (pr.mergeStateStatus === 'BLOCKED') return 'blocked by branch protection'
  return null
}

export type StageState = 'done' | 'fail' | 'run' | 'part' | 'wait' | 'ready' | 'unknown'
export interface PrStage {
  label: 'Opened' | 'Checks' | 'Review' | 'Merge' | 'Merged'
  state: StageState
  detail: string
}

const STAGE_WORD: Record<StageState, string> = {
  done: 'done',
  fail: 'blocked',
  run: 'running',
  part: 'in progress',
  wait: 'waiting',
  ready: 'ready',
  unknown: 'unknown',
}

/** The four steps to landing, for the stage rail. */
export function prStages(pr: AnyPr): PrStage[] {
  const stage = (label: PrStage['label'], state: StageState): PrStage => ({
    label,
    state,
    detail: STAGE_WORD[state],
  })
  if (pr.state === 'MERGED')
    return [
      stage('Opened', 'done'),
      stage('Checks', 'done'),
      stage('Review', 'done'),
      stage('Merged', 'done'),
    ]
  const facts = checkFacts(pr)
  const checks: StageState = facts.failed
    ? 'fail'
    : facts.pending
      ? 'run'
      : facts.known
        ? 'done'
        : 'unknown'
  const summary = isSummary(pr) ? pr : undefined
  const review: StageState =
    pr.reviewDecision === 'CHANGES_REQUESTED'
      ? 'fail'
      : pr.reviewDecision === 'APPROVED'
        ? 'done'
        : summary?.approvedBy.length
          ? 'part'
          : 'wait'
  const merge: StageState =
    pr.state === 'CLOSED' || pr.mergeable === 'CONFLICTING'
      ? 'fail'
      : checks === 'done' && review === 'done'
        ? 'ready'
        : 'wait'
  return [
    stage('Opened', pr.state === 'DRAFT' ? 'part' : 'done'),
    stage('Checks', checks),
    stage('Review', review),
    stage('Merge', merge),
  ]
}
