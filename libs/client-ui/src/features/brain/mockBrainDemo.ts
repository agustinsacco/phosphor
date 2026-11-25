import type { BrainJob } from '@shared/brain'
import { mockBrainJob } from './mockBrainData'

/** The read every mock starts with: one that failed and waits for Retry or Dismiss. */
export function mockStartingJobs(): BrainJob[] {
  return [
    mockBrainJob({
      id: 'harbor-demo-failed',
      sessionId: 'ledger-retry-lane',
      sessionPath: '/demo/Harbor/failed-demo.jsonl',
      title: 'Ledger extraction to retry',
      state: 'failed',
      memories: 0,
      error: 'Invented provider timeout · Retry resumes the same job',
    }),
  ]
}

/** What only the browser harness adds: two reads already saved, and one about to be read. */
export function mockDemoReads(): { saved: BrainJob[]; queued: BrainJob[] } {
  const saved = [
    mockBrainJob({
      id: 'harbor-job',
      title: 'Harbor planning',
      state: 'running',
      queuedAt: 1793880000000,
    }),
    mockBrainJob({
      id: 'ledger-job',
      sessionId: 'ledger-lane',
      sessionPath: '/demo/Harbor/ledger-handover.jsonl',
      title: 'Ledger handover',
      state: 'running',
      queuedAt: 1793883600000,
    }),
  ]
  const queued = [
    mockBrainJob({
      id: 'kestrel-demo-read',
      sessionId: 'kestrel-lane',
      sessionPath: '/demo/Harbor/kestrel-launch.jsonl',
      title: 'Kestrel launch review',
      state: 'queued',
      memories: 0,
      startedAt: null,
      finishedAt: null,
    }),
  ]
  return { saved, queued }
}
