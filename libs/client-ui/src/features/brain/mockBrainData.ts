import {
  BRAIN_EMBEDDING_MODEL,
  DEFAULT_BRAIN_PREFS,
  type BrainStatus,
  type BrainEntity,
  type BrainMemoryDetail,
  type BrainJob,
  type BrainProposalView,
} from '@shared/brain'

/** Invented Harbor notes: enough neighbours and memories to exercise bounded paging. */
export function mockBrainData(): { entities: BrainEntity[]; details: BrainMemoryDetail[] } {
  const entities = mockEntities()
  const specs = [
    {
      subject: 'ledger',
      object: 'harbor',
      predicate: 'for_customer' as const,
      summary: 'Harbor Ledger is built for Harbor.',
    },
    {
      subject: 'rina',
      object: 'ledger',
      predicate: 'owns' as const,
      summary: 'Rina Okafor owns Harbor Ledger migrations.',
    },
    {
      subject: 'tom',
      object: 'ledger',
      predicate: 'works_on' as const,
      summary: 'Tom Lee supports Harbor Ledger.',
    },
    ...entities.slice(4).map((entity) => ({
      subject: entity.id,
      object: 'harbor',
      predicate: 'part_of' as const,
      summary: `${entity.label} is part of Harbor.`,
    })),
  ]
  const details = specs.map((spec, index): BrainMemoryDetail => {
    const id = `memory-${index}`
    const link = {
      id: `link-${index}`,
      subjectId: spec.subject,
      objectId: spec.object,
      predicate: spec.predicate,
      memoryId: id,
    }
    const quotes = [{ before: '', quote: spec.summary, after: '', label: 'You · Harbor planning' }]
    return {
      memory: {
        id,
        jobId: null,
        summary: spec.summary,
        type: index === 0 ? 'decision' : 'fact',
        kind: 'reported',
        state: index === 3 ? 'disputed' : index === 4 ? 'superseded' : 'active',
        entityIds: [spec.subject, spec.object],
        links: [link],
        scope: '/demo/Harbor',
        branch: null,
        validFrom: null,
        validTo: null,
        recordedAt: 1793966400000,
        observedAt: 1793880000000,
        origin: { sessionId: 'harbor-lane', title: 'Harbor planning' },
      },
      quotes,
      linkQuotes: { [link.id]: quotes },
      entities: entities.filter((entity) => [spec.subject, spec.object].includes(entity.id)),
      history: [],
      related: [],
      sourcePath: null,
    }
  })
  details[3]!.related = [{ kind: 'conflicts', memory: details[5]!.memory }]
  details[5]!.memory.state = 'disputed'
  details[5]!.related = [{ kind: 'conflicts', memory: details[3]!.memory }]
  details[4]!.history = [details[6]!.memory]
  return { entities, details }
}

export function mockBrainStatus(): BrainStatus {
  return {
    supported: true,
    prefs: { ...DEFAULT_BRAIN_PREFS },
    revision: 0,
    generation: 'mock-generation-0',
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
    title: 'Harbor planning',
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
    progress: null,
    ...patch,
  }
}

export function mockBrainProposal(job = mockBrainJob(), revision = 0): BrainProposalView {
  const sample = mockBrainData()
  return {
    job,
    revision,
    identities: sample.entities.slice(0, 4).map((entity, index) => ({
      ...entity,
      ref: entity.id,
      decision: index === 2 ? 'uncertain' : 'reuse',
      entityId: index === 2 ? null : entity.id,
      candidates: [entity],
      reason:
        index === 2
          ? 'Same name; please confirm the project context.'
          : 'Matches a known identifier.',
      auto: index !== 2,
    })),
    groups: [
      {
        index: 0,
        parent: { label: 'Harbor', kind: 'organization', entityId: 'harbor' },
        members: ['ledger'],
        labels: ['Harbor Ledger', 'Harbor support', 'Harbor billing'],
      },
    ],
    memories: sample.details.slice(0, 2).map(({ memory, quotes }, index) => ({
      index,
      summary: memory.summary,
      type: memory.type,
      kind: memory.kind,
      entities: memory.entityIds,
      links: memory.links.map((link) => ({
        subject: link.subjectId,
        object: link.objectId,
        predicate: link.predicate,
        quote: quotes[0]!.quote,
      })),
      branch: false,
      validFrom: null,
      validTo: null,
      action: index ? 'enrich' : 'add',
      target: index ? { id: memory.id, summary: memory.summary } : null,
      reason: index ? 'Adds a supported ownership link.' : 'New assertion.',
      quotes,
    })),
    confirmations: [
      {
        id: 'memory-2',
        summary: sample.details[2]!.memory.summary,
        claim: {
          summary: sample.details[2]!.memory.summary,
          type: 'fact',
          kind: 'reported',
          entities: ['tom', 'ledger'],
          links: [
            {
              subject: 'tom',
              object: 'ledger',
              predicate: 'works_on',
              quote: sample.details[2]!.quotes[0]!.quote,
            },
          ],
          branch: false,
          validFrom: null,
          validTo: null,
          action: 'add',
          target: null,
          reason: 'Same assertion and links',
          quotes: sample.details[2]!.quotes,
        },
      },
    ],
    held: 2,
  }
}

function mockEntities(): BrainEntity[] {
  return [
    {
      id: 'harbor',
      label: 'Harbor',
      kind: 'organization',
      aliases: ['Harbor customer'],
      description: 'Customer of the Ledger project',
    },
    {
      id: 'ledger',
      label: 'Harbor Ledger',
      kind: 'project',
      aliases: ['Ledger'],
      description: 'Billing project for Harbor',
    },
    {
      id: 'rina',
      label: 'Rina Okafor',
      kind: 'person',
      aliases: [],
      description: 'Ledger migration owner',
    },
    {
      id: 'tom',
      label: 'Tom Lee',
      kind: 'person',
      aliases: [],
      description: 'Ledger support lead',
    },
    ...Array.from({ length: 25 }, (_, i): BrainEntity => ({
      id: `component-${i}`,
      label: `Harbor component ${i + 1}`,
      kind: 'component',
      aliases: [],
      description: 'Ledger billing component',
    })),
  ]
}
