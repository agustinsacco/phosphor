import { expect, it } from 'vitest'
import { DEFAULT_BRAIN_PREFS, type BrainPrefs } from '@phosphor/shared/brain'
import { fixture } from './test-support'

it('defaults the reader model to null, including older stored preferences', () => {
  const { store, db } = fixture()
  expect(store.snapshot().prefs).toHaveProperty('model', null)
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('prefs', ?)").run(
    JSON.stringify({ enabled: true, recall: false, review: true }),
  )
  expect(store.snapshot().prefs).toEqual({
    enabled: true,
    recall: false,
    review: true,
    model: null,
  })
})

it.each([null, 'harbor/reader', 'harbor/team/reader', `p/${'m'.repeat(198)}`])(
  'round trips reader model %s',
  (model) => {
    const { store } = fixture()
    const prefs = { ...DEFAULT_BRAIN_PREFS, model }
    expect(store.setPrefs(prefs)).toEqual(prefs)
    expect(store.snapshot().prefs).toEqual(prefs)
  },
)

it.each([
  '-harbor/reader',
  'harbor/read er',
  'harbor/reader\n',
  'harbor/rea\u0000der',
  'harbor/rea\u007fder',
  'harbor/rea\u0085der',
  'reader',
  '/reader',
  'harbor/',
  '',
  `p/${'m'.repeat(199)}`,
  7,
  false,
  {},
  undefined,
])('refuses invalid reader model %j without saving', (model) => {
  const { store } = fixture()
  expect(() => store.setPrefs({ ...DEFAULT_BRAIN_PREFS, model } as BrainPrefs)).toThrow(
    'Invalid Brain reader model',
  )
  expect(store.snapshot().prefs).toEqual(DEFAULT_BRAIN_PREFS)
})
