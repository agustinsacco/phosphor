import type { BrainHit, BrainLink, BrainMemory, BrainRecall } from '@phosphor/shared/brain'

const OWNS: BrainLink = {
  id: 'owns',
  subjectId: 'rina',
  predicate: 'owns',
  objectId: 'harbor',
  memoryId: 'ownership',
}

export const HARBOR_RECALL: BrainRecall = {
  status: 'ok',
  entities: [
    { id: 'rina', label: 'Rina Okafor', kind: 'person', aliases: ['Rina'], description: '' },
    {
      id: 'harbor',
      label: 'Harbor',
      kind: 'project',
      aliases: ['Harbor billing'],
      description: 'Billing project',
    },
  ],
  hits: [
    {
      memory: {
        id: 'ownership',
        jobId: null,
        summary: 'Rina Okafor owns Harbor billing.',
        type: 'fact',
        kind: 'reported',
        state: 'active',
        entityIds: ['rina', 'harbor'],
        links: [OWNS],
        scope: '/projects/harbor',
        branch: null,
        validFrom: null,
        validTo: null,
        recordedAt: Date.parse('2026-11-08'),
        observedAt: Date.parse('2026-11-06'),
        origin: { sessionId: 'harbor-lane', title: 'Harbor billing' },
      },
      score: 0.03,
      reasons: ['exact', 'semantic'],
    },
  ],
  focus: ['harbor'],
  paths: [[OWNS]],
  more: 0,
  branch: null,
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
    { id: 'tom', label: 'Tom Lee', kind: 'person', aliases: [], description: '' },
  ],
  hits: [
    OWNERSHIP,
    hit('retries', {
      summary: 'Invoices retry three times before paging.',
      type: 'risk',
      entityIds: ['harbor'],
      links: [],
      observedAt: Date.parse('2026-11-07'),
    }),
    hit('review', {
      summary: 'Tom Lee reviews every payment change.',
      type: 'procedure',
      entityIds: ['tom', 'harbor'],
      links: [],
    }),
    hit('limit', {
      summary: 'The retry limit is still under review.',
      type: 'open',
      links: [],
      scope: '/projects/ledger',
      observedAt: Date.parse('2026-11-01'),
    }),
    hit('monthly', {
      summary: 'Harbor bills monthly, not weekly.',
      type: 'decision',
      links: [],
      validFrom: Date.parse('2026-10-01'),
    }),
  ],
  more: 3,
}
