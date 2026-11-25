import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBrainSearch } from './search'
import { DatabaseSync } from 'node:sqlite'
import { afterEach } from 'vitest'
import { openBrainStore } from './store'
import { suggestionTestStore, type SuggestionTestStore } from './tidy/test-store'
import type { BrainStore, NewJob, Proposal, SavedRead } from './types'

const stores: BrainStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
export function fixture(start = 1000): { store: SuggestionTestStore; db: DatabaseSync } {
  const databases: DatabaseSync[] = []
  let counter = 0
  let time = start
  class Database extends DatabaseSync {
    constructor(path: string, options?: { timeout?: number }) {
      super(path, options ?? {})
      databases.push(this)
    }
  }
  const now = () => time++
  const id = () => `id-${++counter}`
  const store = openBrainStore({
    path: ':memory:',
    Database,
    now,
    id,
  })
  stores.push(store)
  return { store: suggestionTestStore(store, { db: databases[0]!, now, id }), db: databases[0]! }
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
            label: 'owns',
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
            label: 'maintains the archive of',
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
/** A queued read of the lane, moved to running as the reader does before it saves. */
export function running(store: BrainStore, patch: Partial<NewJob> = {}): string {
  const job = store.enqueue(lane(patch), 'queued')
  store.updateJob(job.id, { state: 'running', startedAt: job.queuedAt })
  return job.id
}
let reads = 0
/** Saves a read built from `extraction`, as the reader does when it finishes. */
export function save(
  store: BrainStore,
  input: Partial<Proposal> = {},
): SavedRead & { jobId: string } {
  const jobId = running(store, {
    sessionId: input.origin?.sessionId ?? 'harbor-lane',
    leafId: `leaf-${input.jobId ?? 'read'}-${++reads}`,
  })
  const data = extraction(jobId, { computedRevision: store.knowledgeRevision(), ...input })
  data.jobId = jobId
  return { ...store.saveRead(data), jobId }
}
/** Saves a read and returns the ids of every memory the overview reaches. */
export function saveAndListMemories(store: BrainStore, input: Partial<Proposal> = {}): string[] {
  save(store, input)
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
