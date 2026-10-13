import { describe, expect, it } from 'vitest'
import { insertDictation } from './insertDictation'

describe('insertDictation', () => {
  it('fills an empty draft', () => {
    expect(insertDictation('', 0, 0, ' Run the tests. ')).toEqual({
      value: 'Run the tests.',
      selectionStart: 14,
      selectionEnd: 14,
    })
  })

  it('spaces itself from the words around the caret', () => {
    const edit = insertDictation('Fix it.Then ship', 7, 7, 'Run the tests.')
    expect(edit?.value).toBe('Fix it. Run the tests. Then ship')
    expect(edit?.selectionStart).toBe(23)
  })

  it('adds no space where there already is one', () => {
    expect(insertDictation('Fix it. ', 8, 8, 'Done.')?.value).toBe('Fix it. Done.')
  })

  it('replaces the selection', () => {
    expect(insertDictation('say WORD here', 4, 8, 'this')?.value).toBe('say this here')
  })

  it('does nothing for an empty transcript', () => {
    expect(insertDictation('draft', 5, 5, '  ')).toBeNull()
  })
})
