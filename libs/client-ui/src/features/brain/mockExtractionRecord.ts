import type { BrainExtractionView, BrainJob } from '@shared/brain'
import { mockCallTrace } from './mockExtractionView'

/** The invented record of one mock read: two calls, their prompts and two claim outcomes. */
export function mockExtractionRecord(
  job: BrainJob,
  thinking: BrainExtractionView['thinking'],
  now: number,
): BrainExtractionView {
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
    thinking,
    calls: [
      {
        stage: 'extract',
        part: 1,
        entryIds: ['s1'],
        inputHash: 'demo-hash',
        answer: JSON.stringify({ claims: ['Ledger is built for Harbor.'] }),
        trace: mockCallTrace(38_000),
        error: null,
      },
      {
        stage: 'links',
        part: 1,
        entryIds: ['s1'],
        inputHash: 'demo-links-hash',
        answer: JSON.stringify({
          links: [
            {
              claim: 'c1',
              subject: 'ledger',
              predicate: 'for_customer',
              object: 'harbor',
              segment: 's1',
              quote: 'Ledger is built for Harbor.',
            },
          ],
        }),
        trace: mockCallTrace(12_000),
        error: null,
      },
    ],
    prompts: [
      'Extract supported claims from this invented Harbor planning window.',
      'Find lasting relationships in the kept Harbor claims and their excerpts.',
    ],
    outcomes: [
      {
        candidate: 'w1:c1',
        summary: 'Ledger is built for Harbor.',
        status: 'kept',
        proposalIndex: 0,
      },
      {
        candidate: 'w1:c2',
        summary: 'Unverified ownership link',
        status: 'dropped',
        reason: 'Link quote not found in s1',
      },
    ],
    error: null,
    startedAt: job.startedAt ?? now,
    // A finished invented read ends when its job did, so "took" stays short.
    finishedAt: job.finishedAt ?? now,
    memories: [],
    source: {
      sessionPath: job.sessionPath,
      title: job.title,
      leafId: job.leafId,
      exists: false,
      segments: [],
    },
  }
}
