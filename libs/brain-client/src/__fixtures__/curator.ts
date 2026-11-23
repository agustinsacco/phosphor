import type { BrainEntity, BrainJob, BrainMemory } from '@phosphor/shared/brain'
import type { BrainReadReview, BrainWaiting } from '@phosphor/shared/brain-agent'
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

export const LEDGER_JOB: BrainJob = {
  id: 'job-ledger',
  replaces: null,
  sessionId: 'ledger-lane',
  sessionPath: '/projects/ledger/.pi/ledger-lane.jsonl',
  title: 'Ledger invoices',
  scope: '/projects/ledger',
  branch: null,
  model: 'anthropic/claude-sonnet',
  state: 'review',
  memories: 2,
  leafId: 'leaf-9',
  error: null,
  queuedAt: Date.parse('2026-11-10'),
  startedAt: Date.parse('2026-11-10'),
  runStartedAt: null,
  fromLeafId: null,
  finishedAt: Date.parse('2026-11-10'),
  usage: null,
  progress: null,
}

export const WAITING: BrainWaiting = {
  counts: { reads: 1, entities: 1, repeats: 0, conflicts: 0, flags: 1 },
  items: [
    {
      kind: 'read',
      jobId: 'job-ledger',
      title: 'Ledger invoices',
      state: 'review',
      memories: 2,
      questions: 1,
      neverRead: false,
      finishedAt: Date.parse('2026-11-10'),
    },
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

export const LEDGER_REVIEW: BrainReadReview = {
  neverRead: false,
  proposal: {
    job: LEDGER_JOB,
    revision: 41,
    replacingMemories: 0,
    identities: [
      {
        ref: 'e1',
        label: 'Rina',
        kind: 'person',
        aliases: [],
        description: 'Approves Ledger invoices',
        decision: 'uncertain',
        entityId: null,
        candidates: [RINA],
        reason: 'Same first name as Rina Okafor.',
        auto: true,
        required: true,
      },
      {
        ref: 'e2',
        label: 'Ledger',
        kind: 'project',
        aliases: [],
        description: 'Invoice service',
        decision: 'new',
        entityId: null,
        candidates: [],
        reason: 'No stored project has this name.',
        auto: false,
        required: false,
      },
    ],
    groups: [],
    memories: [
      {
        index: 0,
        summary: 'Rina approves Ledger invoices over 10,000 USD.',
        type: 'procedure',
        kind: 'reported',
        entities: ['e1', 'e2'],
        links: [],
        branch: false,
        validFrom: null,
        validTo: null,
        action: 'add',
        target: null,
        reason: 'New procedure.',
        quotes: [
          { quote: 'Rina signs off anything over 10k', before: '', after: '', label: 'user' },
        ],
        hold: null,
      },
      {
        index: 1,
        summary: 'Rina is out next week.',
        type: 'fact',
        kind: 'reported',
        entities: ['e1'],
        links: [],
        branch: false,
        validFrom: null,
        validTo: null,
        action: 'add',
        target: null,
        reason: 'Near-term status.',
        quotes: [{ quote: 'Rina is out next week', before: '', after: '', label: 'user' }],
        hold: 'temporary',
      },
    ],
    confirmations: [],
    held: 0,
  },
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
  merged: [],
}

export const OWNERSHIP_DETAIL: BrainMemoryDetail = {
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
