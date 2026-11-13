import type { GhPrDetail, GhPrSummary } from '@shared/models'
import type { PrHandoff } from '../prHandoff'
import { checkFacts, mergeBlock } from '../prVerdict'
import { groupChecks, inspectorChecks, type CheckGroups } from './checkGroups'

/**
 * The Overview's merge checklist: what is left before this PR can merge, one
 * row per gate, each with the hand-off that would move it. Wording only; the
 * component draws it.
 */
export type ChecklistId = 'checks' | 'review' | 'threads' | 'branch' | 'merge'
export type ChecklistTone = 'ok' | 'bad' | 'warn' | 'wait'

export interface ChecklistRow {
  id: ChecklistId
  tone: ChecklistTone
  label: string
  text: string
  /** A hand-off draft, or `open` for "Open on GitHub". */
  action?: { kind: PrHandoff | 'open'; label: string }
  /** Has inline detail behind "details". */
  expandable: boolean
}

const people = (names: string[]) => names.map((n) => `@${n}`).join(', ')
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function checksText(groups: CheckGroups): string {
  if (!groups.known) return 'GitHub did not list the checks'
  const { counts } = groups
  if (!counts.total) return 'No checks reported'
  const parts = [`${counts.passed} passed`]
  if (counts.neutral) parts.push(`${counts.neutral} neutral`)
  if (counts.skipped) parts.push(`${counts.skipped} skipped`)
  if (counts.pending) parts.push(`${counts.pending} running`)
  const failing = groups.lead.filter((c) => c.state === 'failure')
  const failed = failing.length
    ? `; ${failing.map((c) => `${c.name} failed${c.required ? '' : ' (not required)'}`).join(', ')}`
    : ''
  const partial = groups.truncated ? '. Over 100 checks: only some are listed' : ''
  return `${parts.join(', ')}${failed}${partial}`
}

function checksRow(groups: CheckGroups): ChecklistRow {
  const { counts } = groups
  const tone: ChecklistTone = counts.failed
    ? 'bad'
    : counts.pending
      ? 'warn'
      : groups.known && !groups.truncated && counts.total
        ? 'ok'
        : 'wait'
  return {
    id: 'checks',
    tone,
    label: 'Checks',
    text: checksText(groups),
    action: counts.failed ? { kind: 'fix-checks', label: 'Fix' } : undefined,
    expandable: counts.total > 0,
  }
}

function reviewRow(pr: GhPrSummary, detail?: GhPrDetail): ChecklistRow {
  const approved = pr.approvedBy.length ? `. ${pr.approvedBy.length} approved` : ''
  const expandable =
    pr.approvedBy.length + pr.changesRequestedBy.length + pr.waitingOn.length > 0 ||
    !!detail?.commented.length
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || pr.changesRequestedBy.length)
    return {
      id: 'review',
      tone: 'warn',
      label: 'Review',
      text: pr.changesRequestedBy.length
        ? `Changes requested by ${people(pr.changesRequestedBy)}`
        : 'Changes requested',
      action: { kind: 'address-changes', label: 'Address' },
      expandable,
    }
  if (pr.reviewDecision === 'APPROVED')
    return {
      id: 'review',
      tone: 'ok',
      label: 'Review',
      text: pr.approvedBy.length ? `Approved by ${people(pr.approvedBy)}` : 'Approved',
      expandable,
    }
  const owners = pr.waitingOn.filter((r) => r.codeOwner)
  const waiting = owners.length ? owners : pr.waitingOn
  return {
    id: 'review',
    tone: 'wait',
    label: owners.length ? 'Code owners' : 'Review',
    text: waiting.length
      ? `Waiting on ${people(waiting.map((r) => r.name))}${approved}`
      : pr.approvedBy.length
        ? `${plural(pr.approvedBy.length, 'approval')}, more needed`
        : 'No review yet',
    action: waiting.length ? { kind: 'nudge-owners', label: 'Nudge' } : undefined,
    expandable,
  }
}

function threadsRow(pr: GhPrSummary): ChecklistRow | null {
  if (!pr.threads)
    return {
      id: 'threads',
      tone: 'wait',
      label: 'Threads',
      text: 'Over 100 threads: see GitHub',
      expandable: false,
    }
  const { total, unresolved } = pr.threads
  if (!total) return null
  return unresolved
    ? {
        id: 'threads',
        tone: 'warn',
        label: 'Threads',
        text: `${unresolved} unresolved of ${total}`,
        action: { kind: 'address-threads', label: 'Address' },
        expandable: true,
      }
    : {
        id: 'threads',
        tone: 'ok',
        label: 'Threads',
        text: `All ${total} resolved`,
        expandable: false,
      }
}

function branchRow(pr: GhPrSummary): ChecklistRow {
  const base = pr.baseRefName || 'its base'
  if (pr.mergeable === 'CONFLICTING')
    return {
      id: 'branch',
      tone: 'bad',
      label: 'Branch',
      text: `Conflicts with ${base}`,
      action: { kind: 'update-branch', label: 'Update' },
      expandable: false,
    }
  if (pr.mergeable === 'MERGEABLE')
    return {
      id: 'branch',
      tone: 'ok',
      label: 'Branch',
      text: `No conflicts with ${base}`,
      expandable: false,
    }
  return {
    id: 'branch',
    tone: 'wait',
    label: 'Branch',
    text: 'GitHub is still checking for conflicts',
    expandable: false,
  }
}

function mergeRow(pr: GhPrSummary): ChecklistRow {
  const block = mergeBlock(pr)
  const row = { id: 'merge', label: 'Merge', expandable: false } as const
  if (block) return { ...row, tone: 'wait', text: `Blocked: ${block}` }
  if (!checkFacts(pr).known)
    return { ...row, tone: 'wait', text: 'Checks unknown: confirm on GitHub' }
  if (pr.inMergeQueue) return { ...row, tone: 'ok', text: 'In the merge queue' }
  if (pr.autoMerge) return { ...row, tone: 'ok', text: 'Auto-merge is on' }
  return {
    ...row,
    tone: 'ok',
    text: 'Ready. Merge on GitHub',
    action: { kind: 'open', label: 'Open ↗' },
  }
}

export function prChecklist(pr: GhPrSummary, detail?: GhPrDetail): ChecklistRow[] {
  const { checks, truncated } = inspectorChecks(pr, detail)
  const rows = [
    checksRow(groupChecks(checks, truncated)),
    reviewRow(pr, detail),
    threadsRow(pr),
    branchRow(pr),
    mergeRow(pr),
  ]
  return rows.filter((row): row is ChecklistRow => row !== null)
}
