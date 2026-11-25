import type { BrainEntity, BrainMemory } from '@phosphor/shared/brain'
import type { BrainWaiting } from '@phosphor/shared/brain-agent'
import type { BrainEntityView, BrainMemoryDetail } from '@phosphor/shared/brain-explore'
import type { BrainTidySuggestionDetail } from '@phosphor/shared/brain-tidy'
import { HARBOR_RECALL } from './recall'

/** Made-up Brain data for Brain Agent's tools: Harbor, Ledger, Rina Okafor and Tom Lee. */
export const RINA: BrainEntity = {
  id: 'rina',
  label: 'Rina Okafor',
  kind: 'person',
  aliases: ['Rina'],
  description: 'Harbor billing lead',
}
export const RINA_SLACK: BrainEntity = {
  id: 'rina-2',
  label: 'Rina',
  kind: 'person',
  aliases: [],
  description: '',
}
export const OWNERSHIP: BrainMemory = HARBOR_RECALL.hits[0]!.memory

export const WAITING: BrainWaiting = {
  counts: { groups: 0, unlinked: 0, entities: 1, repeats: 0, conflicts: 0, flags: 1 },
  items: [
    {
      kind: 'same_entity',
      suggestionId: 'sugg-rina',
      subjects: [
        { type: 'entity', id: 'rina', label: 'Rina Okafor' },
        { type: 'entity', id: 'rina-2', label: 'Rina' },
      ],
      reason: 'Same first name and both work on Harbor.',
      problem: null,
      createdAt: Date.parse('2026-11-11'),
    },
    {
      kind: 'flagged',
      suggestionId: 'flag-ownership',
      subjects: [{ type: 'memory', id: 'ownership', label: 'Rina Okafor owns Harbor billing.' }],
      reason: 'Tom Lee took over Harbor billing in November.',
      problem: 'outdated',
      createdAt: Date.parse('2026-11-12'),
    },
  ],
  more: 0,
}

export const RINA_VIEW: BrainEntityView = {
  entity: { ...RINA, memories: 3, connections: 1 },
  sources: [{ sessionId: 'harbor-lane', title: 'Harbor billing', memories: 3 }],
  lastLearnedAt: Date.parse('2026-11-06'),
  groups: [
    {
      predicate: 'owns',
      direction: 'out',
      total: 1,
      items: [
        {
          entity: {
            id: 'harbor',
            label: 'Harbor',
            kind: 'project',
            aliases: [],
            description: '',
            memories: 4,
            connections: 2,
          },
          link: OWNERSHIP.links[0]!,
          supports: 1,
        },
      ],
      next: null,
    },
  ],
  memoryCounts: { decision: 0, open: 0, risk: 0, procedure: 1, preference: 0, fact: 2 },
  ended: [],
  together: [],
  togetherMore: 0,
  merged: [],
}

export const OWNERSHIP_DETAIL: BrainMemoryDetail = {
  use: { recalled: 4, flagged: 1, lastRecalledAt: null },
  memory: OWNERSHIP,
  quotes: [{ quote: 'Rina owns Harbor billing', before: 'As agreed, ', after: '.', label: 'user' }],
  linkQuotes: {},
  entities: HARBOR_RECALL.entities,
  history: [],
  related: [],
  sourcePath: null,
}

export const RINA_SUGGESTION: BrainTidySuggestionDetail = {
  suggestion: {
    id: 'sugg-rina',
    kind: 'same_entity',
    source: 'sweep',
    state: 'open',
    subjects: [
      { type: 'entity', id: 'rina', label: 'Rina Okafor' },
      { type: 'entity', id: 'rina-2', label: 'Rina' },
    ],
    reason: 'Same first name and both work on Harbor.',
    detail: null,
    verdict: null,
    model: null,
    flag: null,
    createdAt: Date.parse('2026-11-11'),
    updatedAt: Date.parse('2026-11-11'),
  },
  subjects: [
    { type: 'entity', value: RINA_VIEW },
    {
      type: 'entity',
      value: { ...RINA_VIEW, entity: { ...RINA_SLACK, memories: 1, connections: 0 }, groups: [] },
    },
  ],
  allowed: ['merge', 'keep', 'unname'],
  foldRefusal: null,
  revision: 7,
}
