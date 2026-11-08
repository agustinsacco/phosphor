import { create } from 'zustand'
import type { BrainJob, BrainStatus } from '@shared/brain'
import type { BrainLearningTarget } from '@shared/brain-learning-jobs'

/** Bounded metadata projection, never a session owner or an inference queue. */
export const useLearningUi = create<{
  policyEpoch: number | null
  enabled: boolean
  workspaces: string[]
  target: BrainLearningTarget | null
  jobId: string | null
  jobs: BrainJob[]
  truncated: boolean
  refresh: number
}>(() => ({
  policyEpoch: null,
  enabled: false,
  workspaces: [],
  target: null,
  jobId: null,
  jobs: [],
  truncated: false,
  refresh: 0,
}))

export function setLearningPolicy(status: BrainStatus): void {
  useLearningUi.setState({
    policyEpoch: status?.supported ? status.snapshot.policyEpoch : null,
    enabled: !!status?.supported && status.snapshot.prefs.enabled,
    workspaces: status?.supported ? status.snapshot.prefs.workspaces : [],
  })
}

export function openLearning(target: BrainLearningTarget): void {
  useLearningUi.setState({ target, jobId: null })
}
export function inspectLearning(jobId: string): void {
  useLearningUi.setState({ jobId, target: null })
}
export function refreshLearning(): void {
  useLearningUi.setState((s) => ({ refresh: s.refresh + 1 }))
}
export function activeLearning(job: BrainJob): boolean {
  return !!job.learning && (job.state === 'queued' || job.state === 'running')
}
