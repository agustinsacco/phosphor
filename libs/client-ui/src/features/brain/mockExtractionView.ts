import type { BrainExtractionView } from '@shared/brain'
import { mockBrainJob } from './mockBrainData'

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
