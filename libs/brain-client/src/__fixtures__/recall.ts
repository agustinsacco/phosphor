import type { BrainHit, BrainMemory, BrainRecall } from '@phosphor/shared/brain'

export const HARBOR_RECALL: BrainRecall = {
  status: 'ok',
  entities: [
    { id: 'rina', label: 'Rina Okafor', kind: 'person', aliases: ['Rina'] },
    { id: 'harbor', label: 'Harbor', kind: 'project', aliases: ['Harbor billing'] },
  ],
  hits: [
    {
      memory: {
        id: 'ownership',
        jobId: null,
        summary: 'Rina Okafor owns Harbor billing.',
        type: 'fact',
        kind: 'reported',
        subjectId: 'rina',
        predicate: 'owns',
        objectId: 'harbor',
        literal: null,
        scope: '/projects/harbor',
        branch: null,
        validFrom: null,
        recordedAt: Date.parse('2026-11-08'),
        observedAt: Date.parse('2026-11-06'),
        origin: { sessionId: 'harbor-lane', title: 'Harbor billing' },
      },
      score: 0.03,
      reasons: ['exact', 'semantic'],
    },
  ],
  focus: ['harbor'],
  links: [{ subjectId: 'rina', predicate: 'owns', objectId: 'harbor' }],
  more: 0,
  degradation: [],
}

const OWNERSHIP = HARBOR_RECALL.hits[0]!
function hit(id: string, patch: Partial<BrainMemory>): BrainHit {
  return { ...OWNERSHIP, memory: { ...OWNERSHIP.memory, id, ...patch } }
}
/** One of each section, in score order, so the briefing has to regroup them. */
export const HARBOR_BRIEFING: BrainRecall = {
  ...HARBOR_RECALL,
  entities: [
    ...HARBOR_RECALL.entities,
    { id: 'tom', label: 'Tom Lee', kind: 'person', aliases: [] },
  ],
  hits: [
    OWNERSHIP,
    hit('retries', {
      summary: 'Invoices retry three times before paging.',
      type: 'risk',
      subjectId: 'harbor',
      objectId: null,
      observedAt: Date.parse('2026-11-07'),
    }),
    hit('review', {
      summary: 'Tom Lee reviews every payment change.',
      type: 'procedure',
      subjectId: 'tom',
      objectId: null,
    }),
    hit('limit', {
      summary: 'The retry limit is still under review.',
      type: 'open',
      scope: '/projects/ledger',
      observedAt: Date.parse('2026-11-01'),
    }),
    hit('monthly', {
      summary: 'Harbor bills monthly, not weekly.',
      type: 'decision',
      validFrom: Date.parse('2026-10-01'),
    }),
  ],
  more: 3,
}
