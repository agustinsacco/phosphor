import type { BrainLink, BrainMemory } from '@phosphor/shared/brain'

import type { BrainHit, BrainRecall } from '@phosphor/shared/brain-recall'

const OWNS: BrainLink = {
  id: 'owns',
  label: '',
  validFrom: null,
  validTo: null,
  statedBy: 'reader',
  subjectId: 'rina',
  predicate: 'owns',
  objectId: 'harbor',
  memoryId: 'ownership',
}

export const HARBOR_RECALL: BrainRecall = {
  mode: 'search',
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
        importance: 2,
        lanes: 2,
        saidBy: 'you',
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
      trail: { seedId: 'harbor', links: [OWNS], entityId: 'rina' },
      score: 0.03,
      reasons: ['exact', 'semantic'],
    },
  ],
  focus: ['harbor'],
  more: 0,
  branch: null,
  degradation: [],
}

const OWNERSHIP = HARBOR_RECALL.hits[0]!
function hit(id: string, patch: Partial<BrainMemory>): BrainHit {
  return { ...OWNERSHIP, trail: null, memory: { ...OWNERSHIP.memory, id, ...patch } }
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
