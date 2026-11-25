import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { seed, dump } from '../tidy/test-support'

it('refuses undo of a correction when a later quote depends on the memory it created', () => {
  const { store, db } = fixture()
  seed(db, 1)
  const note = { runId: null, reason: 'The current source corrects this claim.' }
  const op = store.correct(
    {
      memoryId: 'memory-1',
      summary: 'Rina leads the Ledger API team.',
      source: 'Linear KES-12',
      quote: 'Rina leads the API team.',
    },
    null,
    note,
  ).operationId
  const memory = db.prepare("SELECT n FROM memories WHERE id!='memory-1'").get() as { n: number }
  db.prepare('INSERT INTO evidence VALUES (999,NULL,?,?,?,?,?)').run(
    'later',
    'user',
    'Linear KES-13',
    1,
    'A later independent quote.',
  )
  db.prepare('INSERT INTO citations VALUES (?,999,?)').run(memory.n, 'A later independent quote.')
  const before = dump(db)
  expect(() => store.agentUndo(op, note)).toThrow('Later changes touch this Brain change')
  expect(dump(db)).toEqual(before)
})
