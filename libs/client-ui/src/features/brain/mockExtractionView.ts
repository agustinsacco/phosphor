import type { BrainExtractionView } from '@shared/brain'
import type { BrainForkTrace } from '@shared/brain-extraction'
import { mockBrainJob } from './mockBrainData'

/** A completed call's trace that took `totalMs`. */
export function mockCallTrace(totalMs: number): BrainForkTrace {
  return {
    firstStdoutMs: null,
    firstMessageStartMs: null,
    firstMessageUpdateMs: null,
    agentStarts: 1,
    turns: 1,
    messageUpdates: 1,
    retries: [],
    compactions: [],
    stopReason: 'stop',
    usage: { tokens: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    totalMs,
    reason: 'completed',
  }
}

export function mockExtractionView(): BrainExtractionView {
  const job = mockBrainJob()
  return {
    job,
    replaceable: 0,
    laneMemories: 0,
    jobId: job.id,
    sessionId: job.sessionId,
    sessionPath: job.sessionPath,
    title: job.title,
    leafId: job.leafId,
    model: job.model,
    thinking: 'low',
    startedAt: 0,
    finishedAt: 5000,
    calls: [
      {
        stage: 'extract',
        part: 1,
        entryIds: ['entry-1'],
        inputHash: 'invented',
        answer: '{ "claims": [] }',
        trace: null,
        error: null,
      },
      {
        stage: 'links',
        part: 1,
        entryIds: ['entry-1'],
        inputHash: 'links-hash',
        answer: '{ "links": [] }',
        trace: null,
        error: null,
      },
      {
        stage: 'reconcile',
        part: 1,
        entryIds: [],
        inputHash: 'another',
        answer: 'No old claims',
        trace: null,
        error: null,
      },
    ],
    prompts: [
      'Read the invented Harbor window.',
      'Find relationships in the kept claims.',
      'Compare the invented claims.',
    ],
    outcomes: [
      {
        candidate: 'w1:c2',
        summary: 'Rejected owner link',
        status: 'dropped',
        reason: 'Link quote not found in s2',
      },
      { candidate: 'w1:c1', summary: 'Harbor decision', status: 'kept', memoryId: 'memory-1' },
    ],
    memories: [{ id: 'memory-1', summary: 'Harbor decision' }],
    error: null,
    source: {
      sessionPath: job.sessionPath,
      title: job.title,
      leafId: job.leafId,
      exists: false,
      segments: [],
    },
  }
}
