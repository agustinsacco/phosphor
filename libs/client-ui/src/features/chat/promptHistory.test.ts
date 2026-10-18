import { describe, expect, it } from 'vitest'
import { recallNext, recallPrevious } from './promptHistory'

const history = ['first', 'second', 'third']

describe('recallPrevious', () => {
  it('starts at the most recent prompt', () => {
    expect(recallPrevious(history, null)).toEqual({ index: 0, text: 'third' })
  })

  it('walks backwards one entry at a time', () => {
    expect(recallPrevious(history, 0)).toEqual({ index: 1, text: 'second' })
    expect(recallPrevious(history, 1)).toEqual({ index: 2, text: 'first' })
  })

  it('stops at the oldest entry rather than wrapping', () => {
    expect(recallPrevious(history, 2)).toBeNull()
  })

  it('does nothing with no history', () => {
    expect(recallPrevious([], null)).toBeNull()
  })
})

describe('recallNext', () => {
  it('is inert when not browsing', () => {
    expect(recallNext(history, null, 'draft')).toBeNull()
  })

  it('walks forwards', () => {
    expect(recallNext(history, 2, 'draft')).toEqual({ index: 1, text: 'second' })
  })

  it('restores the draft past the newest entry', () => {
    expect(recallNext(history, 0, 'draft')).toEqual({ index: null, text: 'draft' })
  })
})
