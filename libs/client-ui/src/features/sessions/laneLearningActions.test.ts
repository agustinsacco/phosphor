import { expect, it, vi } from 'vitest'
import { laneActions, type LaneActionContext } from './laneActions'

const base: LaneActionContext = {
  pinned: false, markers: 'off', pr: null, unseen: false, running: false,
  busy: false, refusals: {},
}
const learning = { localSource: true, ready: true, private: false, busy: false }
const handler = vi.fn()
it('offers source learning in the shared menu for local persisted plain folders', () => {
  const items = laneActions({ ...base, learning }, { learn: handler })
  expect(items.map((i) => i.label)).toEqual(['Learn from this lane…'])
  expect(items[0]?.disabled).toBe(false)
})
it('never offers learning to a Host, missing capability, or private learner', () => {
  for (const value of [undefined, { ...learning, localSource: false }, { ...learning, private: true }])
    expect(laneActions({ ...base, learning: value }, { learn: handler })).toEqual([])
})
it('refuses unready, streaming or otherwise busy sources without invoking', () => {
  for (const value of [{ ...learning, ready: false }, { ...learning, busy: true }]) {
    expect(laneActions({ ...base, learning: value }, { learn: handler })[0]?.disabled).toBe(true)
  }
  expect(laneActions({ ...base, learning, busy: true }, { learn: handler })[0]?.disabled).toBe(true)
  expect(handler).not.toHaveBeenCalled()
})
