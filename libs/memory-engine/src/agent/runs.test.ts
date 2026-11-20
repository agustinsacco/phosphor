import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { seed } from '../tidy/test-support'

it('persists run progress, undoes newest first and retains the latest run beyond 200 changes', () => {
  const { store, db } = fixture()
  seed(db, 2)
  const run = store.createRun()
  expect(run).toMatchObject({ state: 'queued', total: 0, decided: 0, erased: 0, undoable: 0 })
  store.updateRun(run.id, {
    state: 'running',
    total: 202,
    startedAt: 2000,
    sessionPath: '/made-up/brain.jsonl',
  })
  for (let i = 0; i < 201; i++)
    store.agentEdit(
      { kind: 'describe', entityId: 'rina-1', description: `Ledger lead ${i}` },
      { runId: run.id, reason: 'The role description is more precise.' },
    )
  store.erase('memory-2', { runId: run.id, reason: 'This claim is no longer supported.' })
  expect(store.latestRun()).toMatchObject({ decided: 202, erased: 1, undoable: 201 })
  expect(db.prepare('SELECT COUNT(*) AS n FROM tidy_operations').get()).toEqual({ n: 202 })
  expect(store.undoRun(run.id)).toEqual({ undone: 201, kept: 1 })
  expect(store.latestRun()).toMatchObject({ decided: 202, erased: 1, undoable: 0 })
  store.interruptRuns('The application stopped during Defrag.')
  expect(store.latestRun()).toMatchObject({
    state: 'failed',
    error: 'The application stopped during Defrag.',
  })
  for (let i = 0; i < 22; i++) store.createRun()
  expect(db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get()).toEqual({ n: 20 })
})
