import type { BrainTidyOperation } from '@shared/brain-tidy'

/** Who made a change, in the list's words. */
export const CHANGE_WHO: Record<BrainTidyOperation['who'], string> = {
  you: 'By you',
  automatic: 'Automatic',
  agent: 'Brain Agent',
}

/** One row of What changed: a single change, or everything one Brain Agent run did. */
export type ChangeRow =
  | { type: 'change'; change: BrainTidyOperation }
  | { type: 'run'; runId: string; changes: BrainTidyOperation[] }

/** Newest first; a run's changes gather under its newest one. */
export function changeRows(items: BrainTidyOperation[]): ChangeRow[] {
  const rows: ChangeRow[] = []
  const runs = new Map<string, Extract<ChangeRow, { type: 'run' }>>()
  for (const change of [...items].sort((a, b) => b.createdAt - a.createdAt)) {
    if (!change.runId) {
      rows.push({ type: 'change', change })
      continue
    }
    const run = runs.get(change.runId)
    if (run) run.changes.push(change)
    else {
      const row = { type: 'run' as const, runId: change.runId, changes: [change] }
      runs.set(change.runId, row)
      rows.push(row)
    }
  }
  return rows
}

export function changeTitle(change: BrainTidyOperation): string {
  return change.kind === 'erase'
    ? `Erased a memory${change.reason ? `: ${change.reason}` : ''}`
    : change.summary
}

/** The lane a saved read came from, as its summary names it: "Read Ledger handover: 2 memories". */
export function readTitle(change: BrainTidyOperation): string {
  return /^Read (.+): \d+ memor/.exec(change.summary)?.[1] ?? 'this read'
}
