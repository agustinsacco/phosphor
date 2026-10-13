import { describe, expect, it } from 'vitest'
import { isLearnablePrompt, normalizeWritingPrefs } from './writing'

describe('normalizeWritingPrefs', () => {
  it('turns spelling on and autocomplete off unless set otherwise', () => {
    expect(normalizeWritingPrefs(undefined)).toEqual({ spellcheck: true, autocomplete: false })
    expect(normalizeWritingPrefs({ spellcheck: 'no', autocomplete: 'yes' })).toEqual({
      spellcheck: true,
      autocomplete: false,
    })
    expect(normalizeWritingPrefs({ spellcheck: false, autocomplete: true })).toEqual({
      spellcheck: false,
      autocomplete: true,
    })
  })
})

describe('isLearnablePrompt', () => {
  it('accepts typed prompts and rejects commands, blanks and pastes', () => {
    expect(isLearnablePrompt('ok good lets open a PR')).toBe(true)
    expect(isLearnablePrompt('  /compact')).toBe(false)
    expect(isLearnablePrompt('!git status')).toBe(false)
    expect(isLearnablePrompt(' \n ')).toBe(false)
    expect(isLearnablePrompt('x'.repeat(2001))).toBe(false)
  })
})
