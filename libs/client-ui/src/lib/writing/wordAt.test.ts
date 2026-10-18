import { describe, expect, it } from 'vitest'
import { wordRangeAt } from './wordAt'

describe('wordRangeAt', () => {
  const text = 'please recieve the mesage'

  it('takes a one-word selection as is (macOS selects on right-click)', () => {
    expect(wordRangeAt(text, 7, 14)).toEqual({ start: 7, end: 14, word: 'recieve' })
  })

  it('widens a caret to the word around it (Windows and Linux)', () => {
    expect(wordRangeAt(text, 10, 10)).toEqual({ start: 7, end: 14, word: 'recieve' })
    expect(wordRangeAt(text, 25, 25)).toEqual({ start: 19, end: 25, word: 'mesage' })
  })

  it('returns null between words or on a multi-word selection', () => {
    expect(wordRangeAt('a  b', 2, 2)).toBeNull()
    expect(wordRangeAt(text, 0, 14)).toBeNull()
  })

  it('keeps inner apostrophes and drops quoting ones', () => {
    expect(wordRangeAt("it doesnt' work", 5, 5)).toEqual({ start: 3, end: 9, word: 'doesnt' })
    expect(wordRangeAt('l’homme', 2, 2)?.word).toBe('l’homme')
  })

  it('leaves identifiers with digits or underscores alone', () => {
    expect(wordRangeAt('use foo_bar', 5, 5)).toBeNull()
    expect(wordRangeAt('the v2beta flag', 5, 5)).toBeNull()
  })

  it('handles letters outside ASCII', () => {
    expect(wordRangeAt('el niño', 5, 5)).toEqual({ start: 3, end: 7, word: 'niño' })
  })
})
