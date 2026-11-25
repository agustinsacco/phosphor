import { expect, it } from 'vitest'
import { DEFAULT_BRAIN_PREFS, type BrainPrefs } from '@phosphor/shared/brain'
import { fixture } from './test-support'

it('defaults the reader model to null, including older stored preferences', () => {
  const { store, db } = fixture()
  expect(store.snapshot().prefs).toHaveProperty('model', null)
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('prefs', ?)").run(
    JSON.stringify({ enabled: true, recall: false, agentAuto: false }),
  )
  expect(store.snapshot().prefs).toEqual({
    enabled: true,
    recall: false,
    agentAuto: false,
    model: null,
    neverRead: DEFAULT_BRAIN_PREFS.neverRead,
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

it.each([{ id: 'harbor/reader' }, '-harbor/reader', 'harbor reader', 42, ['harbor/reader']])(
  'reads a malformed stored reader model %j as null',
  (model) => {
    const { store, db } = fixture()
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('prefs', ?)").run(
      JSON.stringify({
        enabled: true,
        recall: true,
        agentAuto: false,
        model,
        neverRead: DEFAULT_BRAIN_PREFS.neverRead,
      }),
    )
    expect(store.snapshot().prefs).toEqual({
      enabled: true,
      recall: true,
      agentAuto: false,
      model: null,
      neverRead: DEFAULT_BRAIN_PREFS.neverRead,
    })
  },
)
it('reads malformed stored switches as their defaults and ignores unknown fields', () => {
  const { store, db } = fixture()
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('prefs', ?)").run(
    JSON.stringify({
      enabled: 'yes',
      recall: null,
      agentAuto: 0,
      model: 'harbor/reader',
      extra: 1,
    }),
  )
  expect(store.snapshot().prefs).toEqual({ ...DEFAULT_BRAIN_PREFS, model: 'harbor/reader' })
})
it('reads stored preferences that are not an object as the defaults', () => {
  const { store, db } = fixture()
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('prefs', ?)").run('[1,2]')
  expect(store.snapshot().prefs).toEqual(DEFAULT_BRAIN_PREFS)
})

it('bounds never-read preferences on write and defaults malformed stored exclusions', () => {
  const { store, db } = fixture()
  const neverRead = {
    titles: Array(50).fill('x'.repeat(80)) as string[],
    sessionIds: Array(5000).fill('harbor-lane') as string[],
  }
  expect(store.setPrefs({ ...DEFAULT_BRAIN_PREFS, neverRead }).neverRead).toEqual(neverRead)
  for (const bad of [
    { ...neverRead, titles: ['x'.repeat(81)] },
    { ...neverRead, titles: Array(51).fill('Harbor') },
    { ...neverRead, sessionIds: Array(5001).fill('harbor') },
  ]) {
    expect(() => store.setPrefs({ ...DEFAULT_BRAIN_PREFS, neverRead: bad })).toThrow(
      'Invalid Brain never-read settings.',
    )
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('prefs', ?)").run(
      JSON.stringify({ ...DEFAULT_BRAIN_PREFS, neverRead: bad }),
    )
    expect(store.snapshot().prefs.neverRead).toEqual(DEFAULT_BRAIN_PREFS.neverRead)
  }
})
