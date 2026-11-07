import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_BRAIN_PREFS, type BrainJob } from '@shared/brain'
import type {
  BrainLearningPreview,
  BrainLearningDetail,
  BrainLearningJobList,
} from '@shared/brain-learning-jobs'

beforeEach(() => vi.resetModules())
it('supports all four synthetic learning channels with null manual processor and reuses completed sources', async () => {
  const { mockBrainCall } = await import('./mockBrain')
  await mockBrainCall('brain:setPrefs', [
    { ...DEFAULT_BRAIN_PREFS, enabled: true, workspaces: ['/synthetic'], processor: null },
  ])
  const target = { workspacePath: '/synthetic', sessionPath: '/synthetic/example.jsonl' }
  const preview = (await mockBrainCall('brain:learnPreview', [target])) as BrainLearningPreview
  expect(preview.binding.provider).toBe('synthetic-source')
  const consent = { policyEpoch: preview.policyEpoch, fingerprint: preview.fingerprint }
  await expect(
    mockBrainCall('brain:learn', [target, { ...consent, fingerprint: 'stale' }]),
  ).rejects.toThrow('consent')
  const job = (await mockBrainCall('brain:learn', [target, consent])) as BrainJob
  expect(
    ((await mockBrainCall('brain:learningDetail', [job.id])) as BrainLearningDetail).outcome,
  ).toEqual({ type: 'no_findings' })
  expect(((await mockBrainCall('brain:learn', [target, consent])) as BrainJob).id).toBe(job.id)
  expect(
    ((await mockBrainCall('brain:learningJobs', [])) as BrainLearningJobList).items,
  ).toHaveLength(1)
  await mockBrainCall('brain:cancel', [job.id])
  expect(((await mockBrainCall('brain:learn', [target, consent])) as BrainJob).id).toBe(job.id)
  const retry = (await mockBrainCall('brain:learn', [
    target,
    { ...consent, retryJobId: job.id },
  ])) as BrainJob
  expect(retry.id).not.toBe(job.id)
})
it('fails closed for unenrolled synthetic targets', async () => {
  const { mockBrainCall } = await import('./mockBrain')
  await expect(
    mockBrainCall('brain:learnPreview', [
      { workspacePath: '/not-enrolled', sessionPath: '/example' },
    ]),
  ).rejects.toThrow('enroll')
})
it('requires acknowledged reprocessing even for success and deduplicates a repeated retry acknowledgment', async () => {
  const { mockBrainCall } = await import('./mockBrain')
  await mockBrainCall('brain:setPrefs', [
    { ...DEFAULT_BRAIN_PREFS, enabled: true, workspaces: ['/synthetic'], processor: null },
  ])
  const target = { workspacePath: '/synthetic', sessionPath: '/synthetic/success.jsonl' }
  const preview = (await mockBrainCall('brain:learnPreview', [target])) as BrainLearningPreview
  const consent = { policyEpoch: preview.policyEpoch, fingerprint: preview.fingerprint }
  const first = (await mockBrainCall('brain:learn', [target, consent])) as BrainJob
  const retry = { ...consent, retryJobId: first.id }
  const second = (await mockBrainCall('brain:learn', [target, retry])) as BrainJob
  expect(second.id).not.toBe(first.id)
  expect(((await mockBrainCall('brain:learn', [target, retry])) as BrainJob).id).toBe(second.id)
  expect(
    ((await mockBrainCall('brain:learningJobs', [])) as BrainLearningJobList).items,
  ).toHaveLength(2)
})
