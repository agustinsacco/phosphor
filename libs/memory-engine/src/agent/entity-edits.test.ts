import { expect, it } from 'vitest'
import type { BrainAgentEdit } from '@phosphor/shared/brain-agent'
import { fixture } from '../test-support'
import { seed } from '../tidy/test-support'

const edits: BrainAgentEdit[] = [
  { kind: 'merge', sourceId: 'rina-1', targetId: 'rina-2' },
  { kind: 'describe', entityId: 'rina-1', description: 'Ledger API lead' },
  { kind: 'removeName', entityId: 'rina-1', name: 'Rina' },
  {
    kind: 'split',
    entityId: 'rina-1',
    memoryIds: ['memory-1'],
    label: 'Rina (Ledger)',
    entityKind: 'person',
  },
]
it.each(edits)('journals agent entity edit $kind with its reason and reverses it', (edit) => {
  const { store, db } = fixture()
  seed(db, 3)
  db.prepare("INSERT INTO entity_names VALUES (99,1,'Rina','rina')").run()
  db.prepare('INSERT INTO mentions VALUES (2,1)').run()
  const note = { runId: null, reason: 'The owner clarified the record.' }
  const operation = store.agentEdit(edit, note)
  expect(store.tidyChanges(50).items.find((item) => item.id === operation)).toMatchObject({
    who: 'agent',
    reason: note.reason,
    undoable: true,
  })
  store.agentUndo(operation, { ...note, reason: 'Restore the earlier record.' })
  expect(store.entity('rina-1').entity.description).toBe('Ledger lead 1')
  expect(store.entity('rina-1').entity.aliases).toContain('Rina')
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})
