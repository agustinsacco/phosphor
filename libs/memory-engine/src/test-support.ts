import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBrainSearch } from './search'
import { DatabaseSync } from 'node:sqlite'
import { afterEach } from 'vitest'
import { openBrainStore } from './store'
import type { BrainStore, NewJob, Proposal } from './types'

const stores: BrainStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
export function fixture(start = 1000): { store: BrainStore; db: DatabaseSync } {
  const databases: DatabaseSync[] = []
  let counter = 0
  let time = start
  class Database extends DatabaseSync {
    constructor(path: string, options?: { timeout?: number }) {
      super(path, options ?? {})
      databases.push(this)
    }
  }
  const store = openBrainStore({
    path: ':memory:',
    Database,
    now: () => time++,
    id: () => `id-${++counter}`,
  })
  stores.push(store)
  return { store, db: databases[0]! }
}
export function vector(x = 1, y = 0, z = 0): Float32Array {
  const result = new Float32Array(768)
  result.set([x, y, z])
  return result
}
export function lane(patch: Partial<NewJob> = {}): NewJob {
  return {
    sessionId: 'harbor-lane',
    sessionPath: '/made-up/harbor.jsonl',
    title: 'Harbor billing',
    scope: '/projects/harbor',
    branch: 'billing',
    model: 'made-up/model',
    leafId: 'leaf-1',
    ...patch,
  }
}
export function extraction(jobId: string, patch: Partial<Proposal> = {}): Proposal {
  return {
    jobId,
    origin: { sessionId: 'harbor-lane', title: 'Harbor billing' },
    scope: '/projects/harbor',
    branch: 'billing',
    computedRevision: 0,
    entities: sampleEntities(),
    memories: [
      {
        summary: 'Rina Okafor owns the Harbor billing service.',
        kind: 'reported',
        type: 'fact',
        entities: ['rina', 'harbor'],
        links: [
          {
            subject: 'rina',
            predicate: 'owns',
            object: 'harbor',
            citation: { evidence: 0, quote: 'Rina owns Harbor.' },
          },
        ],
        branch: false,
        validFrom: null,
        validTo: null,
        action: 'add',
        target: null,
        reason: '',
        citations: [{ evidence: 0, quote: 'Rina owns Harbor.' }],
      },
      {
        summary: 'Tom Lee maintains the Harbor invoice archive.',
        kind: 'observed',
        type: 'procedure',
        entities: ['tom', 'harbor'],
        links: [
          {
            subject: 'tom',
            predicate: 'works_on',
            object: 'harbor',
            citation: { evidence: 1, quote: 'Tom maintains the archive.' },
          },
        ],
        branch: true,
        validFrom: 1700000000000,
        validTo: null,
        action: 'add',
        target: null,
        reason: '',
        citations: [{ evidence: 1, quote: 'Tom maintains the archive.' }],
      },
    ],
    evidence: [
      {
        sessionId: 'harbor-lane',
        entryId: 'entry-1',
        role: 'user',
        label: 'You · Nov 6, 12:47',
        observedAt: 10,
        text: 'Before the meeting. Rina owns Harbor. After the meeting.',
      },
      {
        sessionId: 'harbor-lane',
        entryId: 'entry-2',
        role: 'toolResult',
        label: 'Tool output · cat',
        observedAt: 11,
        text: 'Tom maintains the archive.',
      },
    ],
    memoryVectors: [vector(1), vector(0, 1)],
    entityVectors: [vector(1), vector(0, 1), vector(0, 0, 1)],
    groups: [],
    confirmations: [],
    held: 0,
    ...patch,
  }
}
export function approve(store: BrainStore, input: Partial<Proposal> = {}): string[] {
  const job = store.enqueue(
    lane({ sessionId: input.origin?.sessionId ?? 'harbor-lane', leafId: input.jobId ?? 'leaf-1' }),
    'queued',
  )
  const data = extraction(job.id, { computedRevision: store.revision(), ...input })
  data.jobId = job.id
  store.propose(data)
  const proposal = store.proposal(job.id)
  store.review(
    job.id,
    { memories: data.memories.map((_, index) => index), identities: {}, groups: [] },
    proposal.revision,
  )
  return store
    .overview(300)
    .nodes.flatMap((node) =>
      store.entityMemories(node.id, {}, null).memories.map((memory) => memory.id),
    )
    .filter((id, i, ids) => ids.indexOf(id) === i)
}

export function searchFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'brain-search-'))
  const path = join(dir, 'brain.sqlite')
  const store = openBrainStore({ path, Database: DatabaseSync })
  const search = openBrainSearch({ path, Database: DatabaseSync })
  afterEach(() => {
    search.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, search, path }
}

function sampleEntities(): Proposal['entities'] {
  return [
    {
      ref: 'harbor',
      label: 'Harbor',
      kind: 'component',
      aliases: ['Harbor billing service'],
      description: '',
      keys: [],
      decision: 'new',
      entityId: null,
      candidates: [],
      reason: '',
      auto: false,
    },
    {
      ref: 'rina',
      label: 'Rina Okafor',
      kind: 'person',
      aliases: ['Rina'],
      description: '',
      keys: [],
      decision: 'new',
      entityId: null,
      candidates: [],
      reason: '',
      auto: false,
    },
    {
      ref: 'tom',
      label: 'Tom Lee',
      kind: 'person',
      aliases: [],
      description: '',
      keys: [],
      decision: 'new',
      entityId: null,
      candidates: [],
      reason: '',
      auto: false,
    },
  ]
}
