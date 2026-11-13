import type { GhPrSummary } from '@shared/models'
import { checkFacts, mergeBlock } from './prVerdict'

/**
 * What changed on one PR between two reads, in words. The inspector's
 * "Since you looked" line and the PR notices both read this, so a change is
 * described the same way wherever it shows.
 */
export type PrChangeKind =
  | 'merged'
  | 'closed'
  | 'reopened'
  | 'ready-for-review'
  | 'checks-failed'
  | 'checks-passed'
  | 'approved'
  | 'changes-requested'
  | 'conflict'
  | 'conflict-resolved'
  | 'ready-to-merge'
  | 'threads-added'
  | 'threads-resolved'
  | 'pushed'

export type PrChangeTone = 'good' | 'bad' | 'warn' | 'info' | 'merged'

export interface PrChange {
  kind: PrChangeKind
  text: string
  tone: PrChangeTone
  /** Worth interrupting for: a notice, not only a line in the inspector. */
  important: boolean
}

const people = (names: string[]) => names.map((n) => `@${n}`).join(', ')
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const added = (before: string[], after: string[]) => after.filter((n) => !before.includes(n))

function stateChanges(before: GhPrSummary, after: GhPrSummary): PrChange[] {
  if (before.state === after.state) return []
  if (after.state === 'MERGED')
    return [{ kind: 'merged', text: 'Merged', tone: 'merged', important: true }]
  if (after.state === 'CLOSED')
    return [{ kind: 'closed', text: 'Closed without merging', tone: 'bad', important: true }]
  if (before.state === 'DRAFT' && after.state === 'OPEN')
    return [
      { kind: 'ready-for-review', text: 'Marked ready for review', tone: 'info', important: false },
    ]
  if (before.state === 'CLOSED')
    return [{ kind: 'reopened', text: 'Reopened', tone: 'info', important: false }]
  return []
}

function checkChanges(before: GhPrSummary, after: GhPrSummary): PrChange[] {
  const was = checkFacts(before)
  const now = checkFacts(after)
  if (!now.known) return []
  const failedBefore = new Set(was.failing.map((c) => c.name))
  const fresh = now.failing.filter((c) => !failedBefore.has(c.name))
  if (fresh.length || (now.failed > was.failed && !now.failing.length)) {
    const names = fresh.map((c) => c.name)
    const required = fresh.some((c) => c.required) || now.requiredFailed !== 0
    const text =
      names.length === 1
        ? `${names[0]} failed${required ? '' : ' (not required)'}`
        : `${plural(Math.max(names.length, now.failed - was.failed), 'check')} failed`
    return [{ kind: 'checks-failed', text, tone: 'bad', important: true }]
  }
  if ((was.failed || was.pending) && !now.failed && !now.pending && now.total)
    return [
      {
        kind: 'checks-passed',
        text: was.failed ? 'Checks green again' : 'Checks passed',
        tone: 'good',
        important: was.failed > 0,
      },
    ]
  return []
}

function reviewChanges(before: GhPrSummary, after: GhPrSummary): PrChange[] {
  const out: PrChange[] = []
  const approvers = added(before.approvedBy, after.approvedBy)
  if (approvers.length)
    out.push({
      kind: 'approved',
      text: `${people(approvers)} approved`,
      tone: 'good',
      important: true,
    })
  const blockers = added(before.changesRequestedBy, after.changesRequestedBy)
  if (blockers.length)
    out.push({
      kind: 'changes-requested',
      text: `${people(blockers)} requested changes`,
      tone: 'warn',
      important: true,
    })
  const was = before.threads?.unresolved ?? 0
  const now = after.threads?.unresolved
  if (now !== undefined && now > was)
    out.push({
      kind: 'threads-added',
      text: `${plural(now - was, 'new unresolved thread')}`,
      tone: 'warn',
      important: false,
    })
  else if (now === 0 && was > 0)
    out.push({
      kind: 'threads-resolved',
      text: 'All threads resolved',
      tone: 'good',
      important: false,
    })
  return out
}

function branchChanges(before: GhPrSummary, after: GhPrSummary): PrChange[] {
  const out: PrChange[] = []
  if (after.mergeable === 'CONFLICTING' && before.mergeable !== 'CONFLICTING')
    out.push({
      kind: 'conflict',
      text: `Now conflicts with ${after.baseRefName || 'its base'}`,
      tone: 'bad',
      important: true,
    })
  else if (before.mergeable === 'CONFLICTING' && after.mergeable === 'MERGEABLE')
    out.push({
      kind: 'conflict-resolved',
      text: 'Conflict resolved',
      tone: 'good',
      important: false,
    })
  if (before.headSha && after.headSha && before.headSha !== after.headSha)
    out.push({ kind: 'pushed', text: 'New commits pushed', tone: 'info', important: false })
  return out
}

/** Changes from `before` to `after`, most important first. Empty when nothing a person cares about moved. */
export function prChanges(before: GhPrSummary, after: GhPrSummary): PrChange[] {
  const terminal = stateChanges(before, after)
  if (terminal.some((c) => c.kind === 'merged' || c.kind === 'closed')) return terminal
  const out = [
    ...terminal,
    ...checkChanges(before, after),
    ...reviewChanges(before, after),
    ...branchChanges(before, after),
  ]
  if (after.state === 'OPEN' && mergeBlock(before) && !mergeBlock(after))
    out.unshift({
      kind: 'ready-to-merge',
      text: 'Ready to merge',
      tone: 'good',
      important: true,
    })
  return out.sort((a, b) => Number(b.important) - Number(a.important))
}
