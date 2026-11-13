import { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { buildBenchmark, clusteredVector } from './benchmark-fixture'
import { approve, searchFixture, vector } from './test-support'

function loadingFixture() {
  const fixture = searchFixture()
  const db = new DatabaseSync(fixture.path)
  buildBenchmark(db, 500, 5000)
  db.close()
  return fixture
}

it('yields during initial load and coalesces concurrent refreshes into one promise', async () => {
  const { search } = loadingFixture()
  const first = search.refresh()
  expect(search.ready()).toBe(false)
  expect(search.refresh()).toBe(first)
  expect(search.find('Ledger 7', null, 5).degradation).toEqual([
    'Semantic index loading; words and names only.',
  ])
  await first
  expect(search.ready()).toBe(true)
  expect(search.nearestMemories([clusteredVector(7)], 5)[0]).toHaveLength(5)
})

it('keeps the complete previous index while an incremental refresh loads and catches a revision change', async () => {
  const { store, search } = searchFixture()
  approve(store)
  await search.refresh()
  const before = search.nearestMemories([vector()], 20)
  approve(store, { jobId: 'second' })
  const loading = search.refresh()
  expect(search.ready()).toBe(true)
  expect(search.nearestMemories([vector()], 20)).toEqual(before)
  approve(store, { jobId: 'third' })
  expect(search.refresh()).toBe(loading)
  await loading
  expect(search.nearestMemories([vector()], 20)[0]).toHaveLength(6)
})

it('abandons a generation that resets between chunks and loads only the replacement', async () => {
  const { store, search } = loadingFixture()
  const loading = search.refresh()
  await setImmediate()
  expect(search.ready()).toBe(false)
  store.reset()
  const ids = approve(store)
  await loading
  expect(search.ready()).toBe(true)
  expect(
    search
      .nearestMemories([vector()], 20)[0]!
      .map((item) => item.id)
      .sort(),
  ).toEqual(ids.sort())
  expect(search.find('Ledger', null, 5).entities).toEqual([])
})

it('stops loading on close without accessing the closed database or becoming ready', async () => {
  const { search } = loadingFixture()
  const loading = search.refresh()
  await setImmediate()
  expect(search.ready()).toBe(false)
  search.close()
  await expect(loading).resolves.toBeUndefined()
  expect(search.ready()).toBe(false)
})
