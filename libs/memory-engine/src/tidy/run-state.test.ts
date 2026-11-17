import { expect, it } from 'vitest'
import type { BrainTidyRun } from '@phosphor/shared/brain-tidy'
import { fixture } from '../test-support'

const run: BrainTidyRun = {
  state: 'done',
  checked: 11,
  total: 12,
  suggestions: 2,
  folded: 0,
  settled: 1,
  model: 'example/reader',
  startedAt: 1,
  finishedAt: 2,
  message: 'Checked 11 pairs; you settled 1 while it ran.',
  error: null,
}

it('persists the model and the settled count, and Reset forgets both', () => {
  const { store } = fixture()
  store.writeRun(run)
  expect(store.readRun()).toEqual(run)
  store.writeRun({ ...run, model: null, settled: 0 })
  expect(store.readRun()).toMatchObject({ model: null, settled: 0 })
  store.writeRun(run)
  store.reset()
  expect(store.readRun()).toBeNull()
})

it.each([
  ['a negative settled count', { settled: -1 }],
  ['a fractional settled count', { settled: 0.5 }],
  ['an overlong model', { model: 'm'.repeat(201) }],
])('refuses %s', (_, patch) => {
  const { store } = fixture()
  expect(() => store.writeRun({ ...run, ...patch } as BrainTidyRun)).toThrow(
    'Invalid Brain Tidy run.',
  )
})
