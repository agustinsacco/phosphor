import type { BrainRecall } from '@phosphor/shared/brain'

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
        recordedAt: Date.parse('2026-11-06'),
        origin: { sessionId: 'harbor-lane', title: 'Harbor billing' },
      },
      score: 0.03,
      reasons: ['exact', 'semantic'],
    },
  ],
  degradation: [],
}
