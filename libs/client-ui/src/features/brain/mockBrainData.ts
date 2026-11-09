import {
  BRAIN_EMBEDDING_MODEL,
  DEFAULT_BRAIN_PREFS,
  type BrainStatus,
  type BrainEntity,
  type BrainMemoryDetail,
  type BrainJob,
} from '@shared/brain'

/** Invented Harbor billing notes, never derived from a real lane. */
export function mockBrainData(): { entities: BrainEntity[]; details: BrainMemoryDetail[] } {
  const entities: BrainEntity[] = [
    { id: 'harbor', label: 'Harbor', kind: 'project', aliases: [] },
    { id: 'postgres', label: 'PostgreSQL', kind: 'component', aliases: ['Postgres'] },
    { id: 'rina', label: 'Rina Okafor', kind: 'person', aliases: [] },
  ]
  const common = {
    kind: 'reported' as const,
    scope: '/demo/Harbor',
    branch: null,
    validFrom: null,
    recordedAt: 1793966400000,
    observedAt: 1793880000000,
    literal: null,
    origin: { sessionId: 'harbor-lane', title: 'Harbor billing decisions' },
  }
  return {
    entities,
    details: [
      {
        memory: {
          ...common,
          id: 'harbor-db',
          summary: 'Harbor uses PostgreSQL so billing updates can share a transaction.',
          type: 'decision',
          subjectId: 'harbor',
          predicate: 'uses',
          objectId: 'postgres',
        },
        quotes: [
          {
            before: 'For the billing service, ',
            quote: 'Harbor uses PostgreSQL',
            after: ' so billing updates can share a transaction.',
            label: 'You · Nov 6, 12:47',
          },
        ],
      },
      {
        memory: {
          ...common,
          id: 'harbor-owner',
          summary: 'Rina Okafor owns Harbor billing migrations.',
          type: 'fact',
          subjectId: 'rina',
          predicate: 'owns',
          objectId: 'harbor',
        },
        quotes: [
          {
            before: '',
            quote: 'Rina Okafor owns Harbor billing migrations.',
            after: '',
            label: 'You · Nov 6, 12:48',
          },
        ],
      },
    ],
  }
}

export function mockBrainStatus(): BrainStatus {
  return {
    supported: true,
    prefs: { ...DEFAULT_BRAIN_PREFS },
    revision: 0,
    counts: { memories: 0, entities: 0 },
    jobs: [],
    embedding: {
      phase: 'missing',
      receivedBytes: 0,
      totalBytes: BRAIN_EMBEDDING_MODEL.downloadBytes,
      modelId: BRAIN_EMBEDDING_MODEL.id,
      dimensions: BRAIN_EMBEDDING_MODEL.dimensions,
    },
  }
}

export function mockBrainJob(patch: Partial<BrainJob> = {}): BrainJob {
  return {
    id: 'harbor-job',
    sessionId: 'harbor-lane',
    sessionPath: '/demo/Harbor/lane.jsonl',
    title: 'Harbor billing decisions',
    scope: '/demo/Harbor',
    branch: null,
    model: 'demo/harbor-model',
    state: 'review',
    memories: 2,
    leafId: 'leaf-1',
    error: null,
    queuedAt: 1793966400000,
    startedAt: 1793966400000,
    finishedAt: 1793966448000,
    usage: null,
    ...patch,
  }
}
