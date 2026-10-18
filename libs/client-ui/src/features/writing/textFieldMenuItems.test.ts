import { describe, expect, it } from 'vitest'
import { buildTextFieldMenu, type FieldSnapshot } from './textFieldMenuItems'

const field = (patch: Partial<FieldSnapshot> = {}): FieldSnapshot => ({
  value: 'please recieve it',
  selectionStart: 7,
  selectionEnd: 14,
  readOnly: false,
  spellcheck: true,
  ...patch,
})

const dictionary = (word: string): string[] | null =>
  word === 'recieve' ? ['receive', 'relieve', 'reprieve', 'retrieve', 'recede', 'receiver'] : null

describe('buildTextFieldMenu', () => {
  it('leads with up to five suggestions, then Add to dictionary, then the edit commands', () => {
    const menu = buildTextFieldMenu(field(), dictionary)
    expect(menu.map((entry) => entry.label)).toEqual([
      'receive',
      'relieve',
      'reprieve',
      'retrieve',
      'recede',
      'Add to dictionary',
      'Cut',
      'Copy',
      'Paste',
      'Select all',
    ])
    expect(menu[0]!.action).toEqual({ kind: 'replace', start: 7, end: 14, text: 'receive' })
    expect(menu[5]!.action).toEqual({ kind: 'learn', word: 'recieve' })
    expect(menu[6]!.separatorAbove).toBe(true)
  })

  it('says so when a misspelled word has no suggestions', () => {
    const menu = buildTextFieldMenu(field(), () => [])
    expect(menu[0]).toMatchObject({ label: 'No suggestions', action: null, disabled: true })
    expect(menu[1]!.label).toBe('Add to dictionary')
  })

  it('offers only the edit commands for a correct word, with no separator', () => {
    const menu = buildTextFieldMenu(field({ value: 'please receive it' }), dictionary)
    expect(menu.map((entry) => entry.label)).toEqual(['Cut', 'Copy', 'Paste', 'Select all'])
    expect(menu[0]!.separatorAbove).toBe(false)
  })

  it('skips spelling when the field or the setting turns it off', () => {
    const menu = buildTextFieldMenu(field({ spellcheck: false }), dictionary)
    expect(menu[0]!.label).toBe('Cut')
  })

  it('disables what cannot apply', () => {
    const disabled = (patch: Partial<FieldSnapshot>): string[] =>
      buildTextFieldMenu(field({ spellcheck: false, ...patch }), dictionary)
        .filter((entry) => entry.disabled)
        .map((entry) => entry.label)
    expect(disabled({ selectionStart: 3, selectionEnd: 3 })).toEqual(['Cut', 'Copy'])
    expect(disabled({ readOnly: true })).toEqual(['Cut', 'Paste'])
    expect(disabled({ value: '', selectionStart: 0, selectionEnd: 0 })).toEqual([
      'Cut',
      'Copy',
      'Select all',
    ])
  })
})
