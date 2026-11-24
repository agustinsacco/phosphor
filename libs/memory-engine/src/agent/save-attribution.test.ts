import { expect, it } from 'vitest'
import { extraction, fixture, save, vector } from '../test-support'
import { seed } from '../tidy/test-support'

const note = { runId: null, reason: 'The lane names all three as Harbor group members.' }

it('opens a read group question for Brain Agent, whose answer is quoted as Brain Agent', () => {
  const { store, db } = fixture()
  const saved = save(store, {
    groups: [
      {
        parent: { label: 'Harbor group', kind: 'organization', entityId: null },
        members: ['harbor', 'rina', 'tom'],
      },
    ],
  })
  expect(saved.groups).toBe(1)
  const before = db.prepare('SELECT COUNT(*) AS n FROM evidence').get()
  const question = store.waitingSuggestions(20, 0).items.find((item) => item.kind === 'group')!
  expect(
    db.prepare('SELECT source FROM tidy_suggestions WHERE id=?').get(question.suggestionId),
  ).toEqual({
    source: 'read',
  })
  const operation = store.resolve(question.suggestionId, { kind: 'group' }, note)
  const added = db.prepare("SELECT role,label FROM evidence WHERE entry_id LIKE 'group:%'").all()
  expect(added).toHaveLength(3)
  for (const row of added) expect(row).toEqual({ role: 'assistant', label: 'Brain Agent' })
  expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({
    n: (before as { n: number }).n + 3,
  })
  expect(store.tidyChanges(50).items[0]).toMatchObject({
    id: operation,
    who: 'agent',
    reason: note.reason,
  })
})
it('fills a reused record description only when it has none, keeping the lane evidence', () => {
  const { store, db } = fixture()
  seed(db, 2)
  db.prepare("UPDATE entities SET description='' WHERE id='rina-1'").run()
  const data = extraction('unused')
  const entities = [
    {
      ...data.entities[0]!,
      decision: 'reuse' as const,
      entityId: 'rina-1',
      description: 'Harbor lead',
    },
    {
      ...data.entities[1]!,
      decision: 'reuse' as const,
      entityId: 'rina-2',
      description: 'Harbor lead',
    },
    data.entities[2]!,
  ]
  const saved = save(store, { entities })
  expect(store.entity('rina-1').entity.description).toBe('Harbor lead')
  expect(store.entity('rina-2').entity.description).toBe('Ledger lead 2')
  expect(
    db.prepare("SELECT role,label FROM evidence WHERE session_id='harbor-lane'").all(),
  ).toEqual(data.evidence.map(({ role, label }) => ({ role, label })))
  expect(store.tidyChanges(50).items[0]).toMatchObject({ jobId: saved.jobId })
})
it('keeps the original speaker on every repeat, a temporary one included', () => {
  const { store, db } = fixture()
  seed(db, 2)
  const data = extraction('unused')
  save(store, {
    confirmations: data.memories.map((claim, index) => ({
      memoryId: `memory-${index + 1}`,
      claim: { ...claim, hold: index ? 'temporary' : undefined },
      vector: vector(),
    })),
    memories: [],
    memoryVectors: [],
  })
  expect(
    db.prepare("SELECT role,label FROM evidence WHERE session_id='harbor-lane'").all(),
  ).toEqual(data.evidence.map(({ role, label }) => ({ role, label })))
  expect(store.memory('memory-1').quotes).toHaveLength(2)
  expect(store.memory('memory-2').quotes).toHaveLength(2)
})
