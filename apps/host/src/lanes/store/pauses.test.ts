import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openStore, type HostStore } from '../store'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'host-pauses-'))
  let store: HostStore = await openStore(join(root, 'state'), process.getuid?.())
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const repository = store.syncRepositories([root])[0]!
  const lane = (n: number) =>
    store.ensureLane({
      repositoryId: repository.id,
      cwd: root,
      sessionFile: join(root, `${n}.jsonl`),
    })
  const reopen = async () => {
    store.close()
    store = await openStore(join(root, 'state'), process.getuid?.())
    return store
  }
  return { store, lane, reopen }
}

it('records, replaces, lists and removes pause rows', async () => {
  const { store, lane } = await setup()
  const a = lane(1).laneId
  const b = lane(2).laneId
  store.pauses.record([
    { laneId: a, pausedAt: 2000, was: 'idle' },
    { laneId: b, pausedAt: 1000, was: 'aborted' },
  ])
  expect(store.pauses.list()).toEqual([
    { laneId: b, pausedAt: 1000, was: 'aborted' },
    { laneId: a, pausedAt: 2000, was: 'idle' },
  ])
  store.pauses.record([{ laneId: b, pausedAt: 3000, was: 'idle' }])
  expect(store.pauses.list().at(-1)).toEqual({ laneId: b, pausedAt: 3000, was: 'idle' })
  expect(store.pauses.remove([a, b, a])).toBe(2)
  expect(store.pauses.list()).toEqual([])
})

it('refuses a bad row without writing any of the batch', async () => {
  const { store, lane } = await setup()
  const a = lane(1).laneId
  expect(() =>
    store.pauses.record([
      { laneId: a, pausedAt: 1, was: 'idle' },
      { laneId: 'not-a-lane', pausedAt: 1, was: 'idle' },
    ]),
  ).toThrow()
  expect(() =>
    store.pauses.record([
      { laneId: a, pausedAt: 1, was: 'idle' },
      { laneId: crypto.randomUUID(), pausedAt: 1, was: 'idle' },
    ]),
  ).toThrow()
  expect(store.pauses.list()).toEqual([])
})

it('keeps rows across a reopen', async () => {
  const { store, lane, reopen } = await setup()
  const a = lane(1).laneId
  store.pauses.record([{ laneId: a, pausedAt: 5, was: 'aborted' }])
  expect((await reopen()).pauses.list()).toEqual([{ laneId: a, pausedAt: 5, was: 'aborted' }])
})
