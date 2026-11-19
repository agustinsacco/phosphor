import type { BrainJob, BrainProposalView } from '@shared/brain'
import { mockBrainJob } from './mockBrainData'

/** The reads every mock starts with: one review and one failed read. */
export function mockStartingJobs(): BrainJob[] {
  return [
    mockBrainJob({
      id: 'harbor-demo-review',
      sessionPath: '/demo/Harbor/planning-demo.jsonl',
      title: 'Harbor identity review',
    }),
    mockBrainJob({
      id: 'harbor-demo-failed',
      sessionPath: '/demo/Harbor/failed-demo.jsonl',
      title: 'Ledger extraction to retry',
      state: 'failed',
      error: 'Invented provider timeout · Retry resumes the same job',
    }),
  ]
}

/** What only the browser harness adds: a lane the owner set Brain never to read. */
export function mockDemoJobs(): BrainJob[] {
  return [
    mockBrainJob({
      id: 'rina-demo-1on1',
      sessionId: 'rina-1on1-lane',
      sessionPath: '/demo/Harbor/rina-1on1.jsonl',
      title: 'Rina Okafor 1:1',
      leafId: 'leaf-rina-1on1',
      queuedAt: 1793966500000,
    }),
  ]
}

/**
 * The harness's Harbor review asks the questions a careful review needs: a required one
 * ("Is Rina in this lane Rina Okafor?", described differently from what Brain has) and two
 * claims held back until the owner ticks them.
 */
export function withDemoQuestions(proposal: BrainProposalView): BrainProposalView {
  const identities = proposal.identities.map((identity) =>
    identity.ref === 'rina'
      ? {
          ...identity,
          label: 'Rina',
          description: 'Leads the Ledger team',
          decision: 'uncertain' as const,
          entityId: null,
          reason: 'Brain knows a Rina Okafor; this lane only says Rina.',
          auto: false,
          required: true,
        }
      : identity,
  )
  const base = proposal.memories[0]!
  const held = (
    index: number,
    hold: 'temporary' | 'personal',
    summary: string,
    entities: string[],
  ) => ({
    ...base,
    index,
    hold,
    summary,
    type: 'fact' as const,
    entities,
    links: [],
    action: 'add' as const,
    target: null,
    reason: hold === 'temporary' ? 'Reads as a near-term plan.' : 'A remark about a person.',
    quotes: [{ before: '', quote: summary, after: '', label: 'You · Harbor planning' }],
  })
  return {
    ...proposal,
    identities,
    memories: [
      ...proposal.memories,
      held(proposal.memories.length, 'temporary', 'Tom Lee is out until Friday.', ['tom']),
      held(proposal.memories.length + 1, 'personal', 'Rina sounded tired on the call.', ['rina']),
    ],
  }
}
