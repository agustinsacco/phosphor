import { describe, expect, it } from 'vitest'
import type { BrainReviewDecision } from '@phosphor/shared/brain-review'
import type { BrainStore } from '../types'
import { extraction, fixture, lane, vector } from '../test-support'
import { seed } from '../tidy/test-support'

const note = { runId: null, reason: 'The sources support these review answers.' }
const decision: BrainReviewDecision = {
  memories: [],
  identities: {},
  groups: [],
  descriptions: [],
  confirmations: [],
}
function decide(store: BrainStore, id: string, choice: BrainReviewDecision, who: 'agent' | 'you') {
  const revision = store.proposal(id).revision
  if (who === 'agent') return store.decideRead(id, choice, revision, note)
  store.review(id, choice, revision)
  return null
}

describe.each(['agent', 'you'] as const)('review attribution for %s', (who) => {
  it('attributes the group answers to the decider, never to the owner for agent answers', () => {
    const { store, db } = fixture()
    const job = store.enqueue(lane(), 'queued')
    store.propose(
      extraction(job.id, {
        memories: [],
        memoryVectors: [],
        groups: [
          {
            parent: { label: 'Harbor group', kind: 'organization', entityId: null },
            members: ['harbor', 'rina', 'tom'],
          },
        ],
      }),
    )
    decide(store, job.id, { ...decision, groups: [0] }, who)
    const evidence = db.prepare('SELECT role,label FROM evidence').all()
    expect(evidence).toHaveLength(3)
    for (const row of evidence)
      expect(row).toEqual({
        role: who === 'agent' ? 'assistant' : 'user',
        label: who === 'agent' ? 'Brain Agent, in review' : 'Stated by you in review',
      })
    const record = store.tidyChanges(50).items[0]
    if (who === 'agent') expect(record).toMatchObject({ who: 'agent', reason: note.reason })
    else expect(record).toBeUndefined()
  })

  it('applies identity and description answers without reattributing the lane evidence', () => {
    const { store, db } = fixture()
    seed(db, 2)
    const job = store.enqueue(lane(), 'queued')
    const data = extraction(job.id)
    data.entities[0] = {
      ...data.entities[0]!,
      decision: 'reuse',
      entityId: 'rina-1',
      description: 'Harbor platform lead',
    }
    store.propose(data)
    decide(
      store,
      job.id,
      { ...decision, memories: [0], identities: { harbor: 'rina-2' }, descriptions: ['harbor'] },
      who,
    )
    expect(store.entity('rina-2').entity.description).toBe('Harbor platform lead')
    expect(store.entity('rina-1').entity.description).toBe('Ledger lead 1')
    const saved = db.prepare('SELECT id FROM memories WHERE job_id=?').get(job.id) as { id: string }
    expect(store.memory(saved.id).memory.entityIds).toContain('rina-2')
    expect(store.memory(saved.id).memory.entityIds).not.toContain('rina-1')
    expect(
      db.prepare("SELECT role,label FROM evidence WHERE session_id='harbor-lane'").all(),
    ).toEqual([{ role: 'user', label: data.evidence[0]!.label }])
    expect(db.prepare("SELECT * FROM evidence WHERE entry_id LIKE 'review:%'").all()).toEqual([])
    if (who === 'agent')
      expect(store.tidyChanges(50).items[0]).toMatchObject({ who: 'agent', jobId: job.id })
  })

  it('keeps original speaker attribution on ordinary and explicitly chosen held confirmations', () => {
    const { store, db } = fixture()
    seed(db, 2)
    const job = store.enqueue(lane(), 'queued')
    const data = extraction(job.id)
    data.confirmations = data.memories.map((claim, index) => ({
      memoryId: `memory-${index + 1}`,
      claim: { ...claim, hold: index ? 'temporary' : undefined },
      vector: vector(),
    }))
    data.memories = []
    data.memoryVectors = []
    store.propose(data)
    decide(store, job.id, { ...decision, confirmations: [1] }, who)
    expect(
      db.prepare("SELECT role,label FROM evidence WHERE session_id='harbor-lane'").all(),
    ).toEqual(data.evidence.map(({ role, label }) => ({ role, label })))
    expect(db.prepare("SELECT * FROM evidence WHERE entry_id LIKE 'review:%'").all()).toEqual([])
    expect(store.memory('memory-1').quotes).toHaveLength(2)
    expect(store.memory('memory-2').quotes).toHaveLength(2)
  })

  it('keeps source attribution when an identity answer turns a confirmation into a new memory', () => {
    const { store, db } = fixture()
    seed(db, 2)
    const job = store.enqueue(lane(), 'queued')
    const data = extraction(job.id)
    data.entities[0] = { ...data.entities[0]!, decision: 'reuse', entityId: 'rina-1' }
    data.confirmations = [{ memoryId: 'memory-1', claim: data.memories[0]!, vector: vector() }]
    data.memories = []
    data.memoryVectors = []
    store.propose(data)
    decide(store, job.id, { ...decision, identities: { harbor: 'rina-2' } }, who)
    const saved = db.prepare('SELECT id FROM memories WHERE job_id=?').get(job.id) as { id: string }
    expect(store.memory(saved.id).memory.entityIds).toContain('rina-2')
    expect(store.memory('memory-1').quotes).toHaveLength(1)
    expect(
      db.prepare("SELECT role,label FROM evidence WHERE session_id='harbor-lane'").all(),
    ).toEqual([{ role: 'user', label: data.evidence[0]!.label }])
  })
})
