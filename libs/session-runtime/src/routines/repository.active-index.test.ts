import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRoutine } from '@phosphor/shared/routines'
import type { DatabaseSync } from 'node:sqlite'
import { RoutineRepository } from './repository'
import { loadRoutineSqlite } from './sqlite'

const now = Date.parse('2026-09-21T08:00Z')
const fixtures: {
  directory: string
  path: string
  repo: RoutineRepository
  inspect: () => DatabaseSync
}[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'routine-active-index-'))
  const path = join(directory, 'routines.sqlite')
  const { DatabaseSync } = loadRoutineSqlite()
  const state = {
    directory,
    path,
    repo: new RoutineRepository(path),
    inspect: () => new DatabaseSync(path),
  }
  fixtures.push(state)
  return state
}
function add(repo: RoutineRepository, name: string) {
  return repo.save(
    {
      ...newRoutine('/workspace'),
      name,
      instructions: 'Test',
      provider: 'test',
      model: 'test',
      trusted: true,
    },
    now,
  )
}
afterEach(() => {
  for (const state of fixtures.splice(0)) {
    state.repo.close()
    rmSync(state.directory, { recursive: true, force: true })
  }
})

it('returns only active rows in created-at and insertion order amid terminal history', () => {
  const { repo } = fixture()
  const history = add(repo, 'History')
  for (let i = 0; i < 240; i++) {
    const run = repo.manual(history.id, `terminal-${i}`, now + i)
    repo.finish(run.id, i % 2 ? 'finished' : 'cancelled', 'Preserved', now + i)
  }
  const first = repo.manual(add(repo, 'First tie').id, 'first', now + 20)
  const earlier = repo.manual(add(repo, 'Earlier').id, 'earlier', now + 10)
  const second = repo.manual(add(repo, 'Second tie').id, 'second', now + 20)
  repo.claim(first.id, now + 20)
  expect(repo.pending().map((run) => [run.id, run.status])).toEqual([
    [earlier.id, 'queued'],
    [first.id, 'running'],
    [second.id, 'queued'],
  ])
  expect(repo.history(undefined, 0, -1)).toHaveLength(243)
  expect(repo.history(history.id, 0, -1).every((run) => run.reason === 'Preserved')).toBe(true)
})

it('opens a pre-index v1 database without losing occurrence identities or owned lanes', () => {
  const state = fixture()
  const routine = add(state.repo, 'Existing')
  const owned = state.repo.manual(routine.id, 'existing', now)
  state.repo.patchRun(owned.id, { sessionPath: '/sessions/owned.jsonl' })
  state.repo.finish(owned.id, 'finished', 'Existing output', now)
  const promoted = state.repo.manual(routine.id, 'promoted', now)
  state.repo.patchRun(promoted.id, { sessionPath: '/sessions/promoted.jsonl' })
  state.repo.promote(promoted.id)
  state.repo.finish(promoted.id, 'finished', '', now)
  state.repo.setBackground(true)
  const before = state.repo.history(routine.id)
  state.repo.close()
  const db = state.inspect()
  db.exec('DROP INDEX IF EXISTS runs_active')
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
  db.close()

  state.repo = new RoutineRepository(state.path)
  expect(state.repo.history(routine.id)).toEqual(before)
  expect(state.repo.get(routine.id)).toEqual(routine)
  expect(state.repo.manual(routine.id, 'existing', now)).toEqual(before[1])
  expect(state.repo.laneIndex()).toEqual({
    '/sessions/owned.jsonl': { routineId: routine.id, runId: owned.id },
  })
  expect(state.repo.background()).toBe(true)
})
