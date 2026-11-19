import { expect, it } from 'vitest'
import {
  brainLaneNeverRead,
  brainTitleNeverRead,
  checkBrainNeverRead,
  DEFAULT_BRAIN_PREFS,
  setBrainLaneNeverRead,
} from './brain'

it.each(['Rina 1-1 prep', 'Harbor 1:1', 'ONE ON ONE with Tom', 'Mara 1on1'])(
  'matches a whole title pattern: %s',
  (title) => {
    expect(brainTitleNeverRead(DEFAULT_BRAIN_PREFS.neverRead, title)).toBe(true)
  },
)
it.each(['2021-11-12', 'Harbor 11:12', 'someone on one', 'x1on1', '1on1x'])(
  'does not match inside a word or number: %s',
  (title) => {
    expect(brainTitleNeverRead(DEFAULT_BRAIN_PREFS.neverRead, title)).toBe(false)
  },
)
it('switches a lane without mutating settings and enforces bounds', () => {
  const prefs = setBrainLaneNeverRead(DEFAULT_BRAIN_PREFS, 'harbor-lane', true)
  expect(brainLaneNeverRead(prefs.neverRead, { sessionId: 'harbor-lane', title: 'Harbor' })).toBe(
    true,
  )
  expect(DEFAULT_BRAIN_PREFS.neverRead.sessionIds).toEqual([])
  expect(setBrainLaneNeverRead(prefs, 'harbor-lane', false).neverRead.sessionIds).toEqual([])
  for (const id of ['', ' ', 'x'.repeat(201)])
    expect(() => setBrainLaneNeverRead(prefs, id, true)).toThrow('Invalid Brain never-read lane.')
  expect(() => setBrainLaneNeverRead(prefs, 'harbor', 'yes' as unknown as boolean)).toThrow()
  for (const value of [
    null,
    {},
    { titles: [''], sessionIds: [] },
    { titles: Array(51).fill('Harbor'), sessionIds: [] },
    { titles: [], sessionIds: Array(5001).fill('harbor') },
  ])
    expect(() => checkBrainNeverRead(value)).toThrow('Invalid Brain never-read settings.')
})
