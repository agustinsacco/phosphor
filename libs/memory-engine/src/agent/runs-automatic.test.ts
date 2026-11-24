import { expect, it } from 'vitest'
import { BRAIN_AUTO_RUN_LIMIT_REFUSAL, BRAIN_AUTO_RUNS_PER_DAY } from '@phosphor/shared/brain-agent'
import { fixture } from '../test-support'

it('refuses an automatic run past the daily limit, inserting nothing, and never limits Defrag', () => {
  const { store, db } = fixture()
  for (let i = 0; i < BRAIN_AUTO_RUNS_PER_DAY; i++) store.createRun(true)
  const rows = () => db.prepare('SELECT automatic FROM agent_runs ORDER BY rowid').all()
  const before = rows()
  expect(before).toEqual(Array.from({ length: BRAIN_AUTO_RUNS_PER_DAY }, () => ({ automatic: 1 })))
  expect(() => store.createRun(true)).toThrow(BRAIN_AUTO_RUN_LIMIT_REFUSAL)
  expect(rows()).toEqual(before)
  store.createRun()
  store.createRun(false)
  expect(rows().slice(-2)).toEqual([{ automatic: 0 }, { automatic: 0 }])
})
it('counts automatic runs over a rolling 24 hours', () => {
  const { store, db } = fixture()
  for (let i = 0; i < BRAIN_AUTO_RUNS_PER_DAY; i++) store.createRun(true)
  db.prepare(
    'UPDATE agent_runs SET queued_at=queued_at-? WHERE rowid=(SELECT MIN(rowid) FROM agent_runs)',
  ).run(86_400_000)
  expect(() => store.createRun(true)).not.toThrow()
  expect(() => store.createRun(true)).toThrow(BRAIN_AUTO_RUN_LIMIT_REFUSAL)
})
