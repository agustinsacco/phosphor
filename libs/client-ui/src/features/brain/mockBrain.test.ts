import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_BRAIN_PREFS, type BrainStatus, type BrainJob, type BrainEvidence } from '@shared/brain'

beforeEach(() => vi.resetModules())
it('requires terms consent and never silently processes with changed model policy', async () => {
  const { mockBrainCall } = await import('./mockBrain')
  await expect(mockBrainCall('brain:download', [false])).rejects.toThrow('consent')
  const status = await mockBrainCall('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true, workspaces: ['/synthetic'], processor: { provider: 'explicit', id: 'model' } }]) as BrainStatus
  await expect(mockBrainCall('brain:process', ['/synthetic', { policyEpoch: status.snapshot.policyEpoch - 1, model: status.snapshot.prefs.processor }])).rejects.toThrow('consent')
  await expect(mockBrainCall('brain:process', ['/synthetic', { policyEpoch: status.snapshot.policyEpoch, model: { provider: 'fallback', id: 'model' } }])).rejects.toThrow('consent')
  const final = await mockBrainCall('brain:status', []) as BrainStatus
  expect(final.snapshot.jobs).toHaveLength(0)
})
it('offers synthetic evidence, revision-checked review and explicit forgetting without I/O', async () => {
  const { mockBrainCall } = await import('./mockBrain')
  const status = await mockBrainCall('brain:setPrefs', [{ ...DEFAULT_BRAIN_PREFS, enabled: true, workspaces: ['/synthetic'], processor: { provider: 'explicit', id: 'model' } }]) as BrainStatus
  const job = await mockBrainCall('brain:process', ['/synthetic', { policyEpoch: status.snapshot.policyEpoch, model: status.snapshot.prefs.processor }]) as BrainJob
  const proposed = await mockBrainCall('brain:status', []) as BrainStatus
  const proposal = proposed.snapshot.proposals[0]!
  const evidence = await mockBrainCall('brain:read', [job.evidenceIds[0]]) as BrainEvidence
  expect(evidence.text).toContain('Synthetic example:')
  await expect(mockBrainCall('brain:review', [proposal.id, true, { graphRevision: -1, policyEpoch: proposal.policyEpoch }])).rejects.toThrow('Stale review')
  await mockBrainCall('brain:review', [proposal.id, true, { graphRevision: proposal.graphRevision, policyEpoch: proposal.policyEpoch }])
  expect((await mockBrainCall('brain:status', []) as BrainStatus).snapshot.claims).toHaveLength(1)
  await mockBrainCall('brain:forget', [job.evidenceIds])
  expect((await mockBrainCall('brain:status', []) as BrainStatus).snapshot.claims).toHaveLength(0)
})
