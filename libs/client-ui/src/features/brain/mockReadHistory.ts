import type { BrainHistory, BrainJob } from '@shared/brain'
import type { MockExplorer } from './mockExplorer'

/** Finished reads are separate from the pushed inbox, as on Desktop. */
export class MockReadHistory {
  jobs: BrainJob[] = []
  constructor(private explorer: MockExplorer) {}
  memories(sessionId: string) {
    return this.explorer.details.filter((d) => d.memory.origin?.sessionId === sessionId)
  }
  finish(job: BrainJob, now: number): void {
    this.jobs = this.jobs.filter((j) => j.sessionId !== job.sessionId)
    this.jobs.unshift({ ...job, state: 'done', finishedAt: now })
  }
  history(limit: number): BrainHistory {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid Brain history limit.')
    return {
      items: this.jobs.slice(0, limit).map((job) => ({
        job,
        memories: this.memories(job.sessionId).length,
        replaceable: this.memories(job.sessionId).length,
      })),
      more: this.jobs.length > limit,
    }
  }
}
