import { describe, expect, it } from 'vitest'
import type { MaintenanceReport } from '@shared/models'
import { combineReports, heldSummary } from './MaintenanceSection'

const report = (over: Partial<MaintenanceReport> = {}): MaintenanceReport => ({
  ranAt: 0,
  workspacePath: '/repo',
  worktreeCount: 0,
  candidates: [],
  held: [],
  prunedRegistrations: [],
  reclaimed: [],
  reclaimableBytes: 0,
  reclaimedBytes: 0,
  liveSessionCount: 0,
  errors: [],
  ...over,
})

describe('combineReports', () => {
  it('sums every workspace, not just the one on screen', () => {
    // Reclaim once covered only the active workspace, and freed one repo's
    // lanes while six others kept theirs.
    const candidate = { path: '/x', branch: 'b', bytes: 10, reason: 'merged' as const }
    const combined = combineReports([
      report({ worktreeCount: 3, candidates: [candidate], reclaimableBytes: 10 }),
      report({
        workspacePath: '/other',
        worktreeCount: 5,
        candidates: [candidate, candidate],
        reclaimableBytes: 20,
        reclaimed: [candidate],
        reclaimedBytes: 10,
      }),
    ])
    expect(combined).toMatchObject({
      worktreeCount: 8,
      candidates: 3,
      reclaimableBytes: 30,
      reclaimed: 1,
      reclaimedBytes: 10,
    })
  })

  it('names the workspace an error came from', () => {
    expect(
      combineReports([report({ workspacePath: '/src/api', errors: ['scan: boom'] })]).errors,
    ).toEqual(['api: scan: boom'])
  })
})

describe('heldSummary', () => {
  it('says why lanes were kept, across workspaces, without counting the main checkout', () => {
    const hold = (reason: MaintenanceReport['held'][number]['reason']) => ({
      path: '/x',
      branch: 'b',
      reason,
    })
    const reports = [
      report({ held: [hold('main-checkout'), hold('dirty'), hold('too-recent')] }),
      report({ held: [hold('main-checkout'), hold('unmerged'), hold('dirty')] }),
    ]
    expect(heldSummary(reports, 24)).toBe('2 uncommitted, 1 not landed, 1 recently used (<24h)')
    expect(heldSummary([report({ held: [hold('main-checkout')] })], 24)).toBe('')
  })
})
