import type { BrainHistory, BrainJob } from '@shared/brain'
import type { MockExplorer } from './mockExplorer'

/**
 * Finished reads, approved or rejected, are separate from the pushed inbox, as on Desktop. A
 * lane keeps every read; each row counts what that read kept, and replaceable stays lane-wide
 * (Read again replaces the whole lane).
 */
export class MockReadHistory {
  jobs: BrainJob[] = []
  constructor(private explorer: MockExplorer) {}
  memories(sessionId: string) {
    return this.explorer.details.filter((d) => d.memory.origin?.sessionId === sessionId)
  }
  finish(job: BrainJob, state: 'done' | 'rejected', now: number): void {
    this.jobs.unshift({ ...job, state, finishedAt: now, runStartedAt: null, progress: null })
  }
  history(limit: number): BrainHistory {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid Brain history limit.')
    return {
      items: this.jobs.slice(0, limit).map((job) => ({
        job,
        memories: this.explorer.details.filter((d) => d.memory.jobId === job.id).length,
        replaceable: this.memories(job.sessionId).length,
      })),
      more: this.jobs.length > limit,
    }
  }
}
