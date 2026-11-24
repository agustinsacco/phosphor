import { expect, it } from 'vitest'
import type { BrainTidyOperation } from '@shared/brain-tidy'
import { changeRows, readTitle } from './changeRows'

const op = (id: string, at: number, runId: string | null = null): BrainTidyOperation => ({
  id,
  kind: runId ? 'relate' : 'read',
  who: runId ? 'agent' : 'automatic',
  reason: null,
  runId,
  jobId: null,
  undoable: true,
  summary: `Read Ledger handover: 2 memories`,
  createdAt: at,
  undoneAt: null,
  suggestionId: null,
})

it('lists changes newest first and gathers a run under its newest change', () => {
  const rows = changeRows([op('a', 1), op('r1', 2, 'run'), op('b', 3), op('r2', 4, 'run')])
  expect(
    rows.map((row) => (row.type === 'run' ? row.changes.map((c) => c.id) : row.change.id)),
  ).toEqual([['r2', 'r1'], 'b', 'a'])
  expect(readTitle(op('a', 1))).toBe('Ledger handover')
})
