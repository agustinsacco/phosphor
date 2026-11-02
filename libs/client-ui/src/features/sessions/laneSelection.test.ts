import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearLaneSelection,
  nextSelection,
  selectLanes,
  toggleLane,
  useLaneSelection,
  type LaneSelectionState,
} from './laneSelection'

const EMPTY: LaneSelectionState = { group: null, keys: [], anchor: null }
const order = ['a', 'b', 'c', 'd']

describe('nextSelection', () => {
  it('toggles single lanes and keeps the group order', () => {
    const one = nextSelection(EMPTY, 'g', order, 'c', false)
    const two = nextSelection(one, 'g', order, 'a', false)
    expect(two).toEqual({ group: 'g', keys: ['a', 'c'], anchor: 'a' })
    expect(nextSelection(two, 'g', order, 'c', false).keys).toEqual(['a'])
  })

  it('leaves select mode when the last lane is toggled off', () => {
    const one = nextSelection(EMPTY, 'g', order, 'b', false)
    expect(nextSelection(one, 'g', order, 'b', false)).toMatchObject({ group: null, keys: [] })
  })

  it('extends a range from the anchor with shift, keeping what was selected', () => {
    const start = { group: 'g', keys: ['a'], anchor: 'b' }
    expect(nextSelection(start, 'g', order, 'd', true)).toEqual({
      group: 'g',
      keys: ['a', 'b', 'c', 'd'],
      anchor: 'b',
    })
  })

  it('treats shift as a plain toggle when the anchor is not in this list', () => {
    const start = { group: 'g', keys: ['a'], anchor: 'gone' }
    expect(nextSelection(start, 'g', order, 'c', true).keys).toEqual(['a', 'c'])
  })

  it('starts over when a lane in another group is picked, never spanning two', () => {
    const start = { group: 'one', keys: ['a', 'b'], anchor: 'b' }
    expect(nextSelection(start, 'two', ['x', 'y'], 'y', false)).toEqual({
      group: 'two',
      keys: ['y'],
      anchor: 'y',
    })
  })
})

describe('the selection store', () => {
  beforeEach(clearLaneSelection)

  it('selects a group, toggles in it and clears', () => {
    selectLanes('g', ['a', 'b'])
    toggleLane('g', order, 'a', false)
    expect(useLaneSelection.getState()).toMatchObject({ group: 'g', keys: ['b'] })
    clearLaneSelection()
    expect(useLaneSelection.getState()).toEqual(EMPTY)
  })

  it('can hold select mode with nothing chosen yet', () => {
    selectLanes('g', [])
    expect(useLaneSelection.getState()).toMatchObject({ group: 'g', keys: [] })
  })
})
