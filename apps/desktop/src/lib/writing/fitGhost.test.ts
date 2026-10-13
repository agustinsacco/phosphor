// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fitGhost, ghostVisibility } from './fitGhost'

describe('fitGhost', () => {
  const ghost = 'en a PR now'

  it('keeps the whole suggestion when it all shows', () => {
    expect(fitGhost(ghost, () => true)).toBe(ghost)
  })

  it('cuts it after the last whole word that shows', () => {
    // 'en' ends at 2, ' a' at 4, ' PR' at 7, ' now' at 11.
    expect(fitGhost(ghost, (end) => end <= 8)).toBe('en a PR')
    expect(fitGhost(ghost, (end) => end <= 3)).toBe('en')
  })

  it('stops at the first word that does not show', () => {
    expect(fitGhost(ghost, (end) => end !== 4)).toBe('en')
  })

  it('shows nothing when not even the first word fits', () => {
    expect(fitGhost(ghost, () => false)).toBeNull()
    expect(fitGhost('   ', () => true)).toBeNull()
  })
})

describe('ghostVisibility', () => {
  it('declines to measure without a text node or without layout', () => {
    const box = document.createElement('div')
    box.textContent = 'text'
    expect(ghostVisibility(box, null)).toBeNull()
    expect(ghostVisibility(box, box)).toBeNull()
    // jsdom: a zero-height box and no Range geometry.
    expect(ghostVisibility(box, box.firstChild)).toBeNull()
  })
})
