import { DatabaseSync } from 'node:sqlite'
import { afterEach } from 'vitest'
import { openBrainStore } from './store'
import type { BrainStore, Extraction, NewJob } from './types'

const stores: BrainStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
export function fixture(): { store: BrainStore; db: DatabaseSync } {
  const databases: DatabaseSync[] = []
  let counter = 0
  let time = 1000
  class Database extends DatabaseSync {
    constructor(path: string) {
      super(path)
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
export function extraction(jobId: string, patch: Partial<Extraction> = {}): Extraction {
  return {
    jobId,
    summary: 'Harbor billing ownership was clarified.',
    origin: { sessionId: 'harbor-lane', title: 'Harbor billing' },
    scope: '/projects/harbor',
    branch: 'billing',
    entities: [
      { key: 'harbor', label: 'Harbor', kind: 'component', aliases: ['Harbor billing service'] },
      { key: 'rina', label: 'Rina Okafor', kind: 'person', aliases: ['Rina'] },
      { key: 'tom', label: 'Tom Lee', kind: 'person', aliases: [] },
    ],
    memories: [
      {
        subject: 'rina',
        predicate: 'owns',
        object: 'harbor',
        literal: null,
        summary: 'Rina Okafor owns the Harbor billing service.',
        kind: 'reported',
        type: 'fact',
        branch: false,
        validFrom: null,
        supersedes: null,
        citations: [{ evidence: 0, quote: 'Rina owns Harbor.' }],
      },
      {
        subject: 'tom',
        predicate: 'works_on',
        object: 'harbor',
        literal: null,
        summary: 'Tom Lee maintains the Harbor invoice archive.',
        kind: 'observed',
        type: 'procedure',
        branch: true,
        validFrom: 1700000000000,
        supersedes: null,
        citations: [{ evidence: 1, quote: 'Tom maintains the archive.' }],
      },
    ],
    evidence: [
      {
        entryId: 'entry-1',
        role: 'user',
        label: 'You · Nov 6, 12:47',
        observedAt: 10,
        text: 'Before the meeting. Rina owns Harbor. After the meeting.',
      },
      {
        entryId: 'entry-2',
        role: 'toolResult',
        label: 'Tool output · cat',
        observedAt: 11,
        text: 'Tom maintains the archive.',
      },
    ],
    vectors: [vector(1), vector(0, 1)],
    ...patch,
  }
}
export function approve(store: BrainStore, input?: Partial<Extraction>): string[] {
  const job = store.enqueue(
    lane({
      sessionId: input?.origin?.sessionId ?? 'harbor-lane',
      leafId: input?.jobId ?? 'leaf-1',
    }),
    'queued',
  )
  const data = extraction(job.id, input)
  data.jobId = job.id
  store.propose(data)
  const proposal = store.proposal(job.id)
  store.review(
    job.id,
    proposal.memories.map((_, index) => index),
    proposal.revision,
  )
  return store.knowledge().memories.map((memory) => memory.id)
}
