import { emptyBrainTidySummary } from '@shared/brain-tidy'
import {
  BRAIN_EMBEDDING_MODEL,
  DEFAULT_BRAIN_PREFS,
  type BrainEntity,
  type BrainJob,
  type BrainLink,
  type BrainMemory,
  type BrainMemoryDetail,
  type BrainPredicate,
  type BrainStatus,
} from '@shared/brain'

/** The day the invented notes were said, and the dates their relationships carry. */
export const MOCK_SAID_AT = Date.UTC(2026, 10, 5)
const day = (month: number, date: number): number => Date.UTC(2026, month - 1, date)

/** You, in the invented Brain: the map centres here until something is selected. */
export const MOCK_OWNER_ID = 'mara'

interface LinkSpec {
  s: string
  p: BrainPredicate
  o: string
  label: string
  from?: number
  to?: number
}
interface MemorySpec {
  summary: string
  entities: string[]
  links?: LinkSpec[]
  type?: BrainMemory['type']
  kind?: BrainMemory['kind']
  importance?: BrainMemory['importance']
  saidBy?: BrainMemory['saidBy']
  lanes?: number
  state?: BrainMemory['state']
  validTo?: number
  title?: string
}

/**
 * Invented Harbor and Ledger notes. People join people ("took over Ledger billing from"), one
 * relationship has ended, two pairs are named together with no link, and Harbor has enough
 * parts to page. New notes go at the end: tests address the early ones by index.
 */
const SPECS: MemorySpec[] = [
  {
    summary: 'Ledger is built for Harbor.',
    entities: ['ledger', 'harbor'],
    links: [{ s: 'ledger', p: 'for_customer', o: 'harbor', label: 'is built for' }],
    type: 'fact',
    lanes: 3,
  },
  {
    summary: 'Tom Lee took over Ledger billing from Rina Okafor in September.',
    entities: ['tom', 'rina', 'ledger'],
    links: [
      {
        s: 'tom',
        p: 'took_over_from',
        o: 'rina',
        label: 'took over Ledger billing from',
        from: day(9, 1),
      },
    ],
    type: 'decision',
    importance: 2,
    saidBy: 'you',
    lanes: 2,
  },
  {
    summary: 'Tom Lee leads the Ledger team.',
    entities: ['tom', 'ledger-team'],
    links: [{ s: 'tom', p: 'leads', o: 'ledger-team', label: 'leads', from: day(9, 1) }],
    kind: 'observed',
  },
  {
    summary: 'Tom Lee reports to Mara Voss.',
    entities: ['tom', 'mara'],
    links: [{ s: 'tom', p: 'reports_to', o: 'mara', label: 'reports to' }],
    saidBy: 'you',
  },
  {
    summary: 'Rina Okafor led the Ledger team until the end of August.',
    entities: ['rina', 'ledger-team'],
    links: [{ s: 'rina', p: 'leads', o: 'ledger-team', label: 'led', to: day(8, 31) }],
  },
  {
    summary: 'Rina Okafor works with Mara Voss on the Kestrel rollout.',
    entities: ['rina', 'mara', 'kestrel'],
    links: [{ s: 'rina', p: 'works_with', o: 'mara', label: 'works with' }],
    lanes: 2,
  },
  {
    summary: 'The Ledger team owns Ledger.',
    entities: ['ledger-team', 'ledger'],
    links: [{ s: 'ledger-team', p: 'owns', o: 'ledger', label: 'owns' }],
    kind: 'observed',
  },
  {
    summary: 'Mara Voss decided Ledger invoices close on the fifth working day.',
    entities: ['mara', 'ledger'],
    links: [{ s: 'mara', p: 'decided', o: 'ledger', label: 'set the invoice close date for' }],
    type: 'decision',
    importance: 2,
    saidBy: 'you',
  },
  {
    summary: 'Kestrel is built for Northwind.',
    entities: ['kestrel', 'northwind'],
    links: [{ s: 'kestrel', p: 'for_customer', o: 'northwind', label: 'is built for' }],
  },
  {
    summary: 'Rina Okafor moved to Kestrel in September.',
    entities: ['rina', 'kestrel'],
    links: [{ s: 'rina', p: 'works_on', o: 'kestrel', label: 'moved to', from: day(9, 1) }],
  },
  {
    summary: 'Tom Lee worked on Kestrel until mid-August.',
    entities: ['tom', 'kestrel'],
    links: [{ s: 'tom', p: 'works_on', o: 'kestrel', label: 'worked on', to: day(8, 15) }],
    kind: 'inferred',
    importance: 0,
  },
  {
    summary: 'Tom Lee and Northwind discussed a Ledger pilot.',
    entities: ['tom', 'northwind', 'ledger'],
    type: 'open',
  },
  {
    summary: 'Tom Lee joined the Northwind quarterly review.',
    entities: ['tom', 'northwind'],
    kind: 'observed',
  },
  {
    summary: 'Harbor invoices close on the fifth working day.',
    entities: ['harbor', 'ledger'],
    type: 'procedure',
  },
  {
    summary: 'Ledger invoices were sent weekly.',
    entities: ['ledger'],
    state: 'superseded',
  },
  {
    summary: 'Ledger invoices go out monthly.',
    entities: ['ledger', 'harbor'],
    state: 'disputed',
  },
  {
    summary: 'Ledger invoices go out every two weeks.',
    entities: ['ledger', 'harbor'],
    state: 'disputed',
  },
  {
    summary: 'Northwind may delay the Kestrel launch to January.',
    entities: ['northwind', 'kestrel'],
    type: 'risk',
    importance: 2,
    validTo: day(12, 31),
  },
  {
    summary: 'Rina Okafor and Harbor reviewed the migration receipts.',
    entities: ['rina', 'harbor'],
    kind: 'observed',
  },
  ...Array.from({ length: 25 }, (_, i): MemorySpec => ({
    summary: `Harbor component ${i + 1} is part of Harbor.`,
    entities: [`component-${i}`, 'harbor'],
    links: [{ s: `component-${i}`, p: 'part_of', o: 'harbor', label: 'is part of' }],
    importance: 0,
  })),
]

function mockLink(spec: LinkSpec, memoryId: string, index: number): BrainLink {
  return {
    id: `link-${memoryId}-${index}`,
    subjectId: spec.s,
    predicate: spec.p,
    objectId: spec.o,
    memoryId,
    label: spec.label,
    validFrom: spec.from ?? null,
    validTo: spec.to ?? null,
    statedBy: 'reader',
  }
}

export function mockBrainData(): { entities: BrainEntity[]; details: BrainMemoryDetail[] } {
  const entities = mockEntities()
  const details = SPECS.map((spec, index): BrainMemoryDetail => {
    const id = `memory-${index}`
    const links = (spec.links ?? []).map((link, at) => mockLink(link, id, at))
    const title = spec.title ?? (index % 3 ? 'Ledger handover' : 'Harbor planning')
    const quotes = [{ before: '', quote: spec.summary, after: '', label: `You · ${title}` }]
    return {
      memory: {
        id,
        jobId: null,
        summary: spec.summary,
        type: spec.type ?? 'fact',
        kind: spec.kind ?? 'reported',
        state: spec.state ?? 'active',
        entityIds: spec.entities,
        links,
        scope: '/demo/Harbor',
        branch: null,
        validFrom: null,
        validTo: spec.validTo ?? null,
        recordedAt: MOCK_SAID_AT + 86_400_000,
        observedAt: MOCK_SAID_AT - index * 3_600_000,
        origin: {
          sessionId: index % 3 ? 'ledger-lane' : 'harbor-lane',
          title,
        },
        importance: spec.importance ?? 1,
        saidBy: spec.saidBy ?? 'agent',
        lanes: spec.lanes ?? 1,
      },
      quotes,
      linkQuotes: Object.fromEntries(links.map((link) => [link.id, quotes])),
      entities: entities.filter((entity) => spec.entities.includes(entity.id)),
      history: [],
      related: [],
      sourcePath: null,
      use: { recalled: index % 4, lastRecalledAt: index % 4 ? MOCK_SAID_AT : null, flagged: 0 },
    }
  })
  details[7]!.history = [details[14]!.memory]
  details[15]!.related = [{ kind: 'conflicts', memory: details[16]!.memory }]
  details[16]!.related = [{ kind: 'conflicts', memory: details[15]!.memory }]
  return { entities, details }
}

export function mockBrainStatus(): BrainStatus {
  return {
    supported: true,
    tidy: emptyBrainTidySummary(),
    agent: {
      waiting: { entities: 0, groups: 0, unlinked: 0, repeats: 0, conflicts: 0, flags: 0 },
      run: null,
      folder: null,
    },
    prefs: { ...DEFAULT_BRAIN_PREFS },
    revision: 0,
    generation: 'mock-generation-0',
    counts: { memories: 0, entities: 0 },
    jobs: [],
    readSessionIds: [],
    ownerId: MOCK_OWNER_ID,
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
    replaces: null,
    sessionId: 'harbor-lane',
    sessionPath: '/demo/Harbor/lane.jsonl',
    title: 'Harbor planning',
    scope: '/demo/Harbor',
    branch: null,
    model: 'demo/harbor-model',
    state: 'done',
    memories: 2,
    leafId: 'leaf-1',
    error: null,
    queuedAt: 1793966400000,
    startedAt: 1793966400000,
    // Only a running job has a current attempt.
    runStartedAt: patch.state === 'running' ? (patch.startedAt ?? 1793966400000) : null,
    fromLeafId: null,
    finishedAt: 1793966448000,
    usage: null,
    progress: null,
    ...patch,
  }
}

function person(id: string, label: string, description: string): BrainEntity {
  return { id, label, kind: 'person', aliases: [], description }
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
      label: 'Ledger',
      kind: 'project',
      aliases: ['Ledger billing', 'Harbor Ledger'],
      description: 'Billing project for Harbor',
    },
    person('rina', 'Rina Okafor', 'Ran Ledger billing, now on Kestrel'),
    person('tom', 'Tom Lee', 'Ledger billing lead'),
    person('mara', 'Mara Voss', 'Head of billing'),
    {
      id: 'ledger-team',
      label: 'Ledger team',
      kind: 'team',
      aliases: [],
      description: 'Builds and runs Ledger',
    },
    {
      id: 'kestrel',
      label: 'Kestrel',
      kind: 'project',
      aliases: [],
      description: 'Payments rewrite for Northwind',
    },
    {
      id: 'northwind',
      label: 'Northwind',
      kind: 'organization',
      aliases: [],
      description: 'Customer of Kestrel',
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
