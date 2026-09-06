import { describe, expect, it } from 'vitest'
import {
  continueList,
  indentSelection,
  lineAt,
  parseListLine,
  pasteIntoList,
  renumber,
  toggleList,
  wrapCodeBlock,
  wrapLink,
  wrapSelection,
} from './composerText'

/** Marks the caret with '|' so the expectations read like what you'd type. */
function at(marked: string): { value: string; caret: number } {
  const caret = marked.indexOf('|')
  return { value: marked.replace('|', ''), caret }
}
function show(edit: { value: string; selectionStart: number } | null): string | null {
  if (!edit) return null
  return edit.value.slice(0, edit.selectionStart) + '|' + edit.value.slice(edit.selectionStart)
}

it('inserts links with an escaped label and selects only the URL placeholder', () => {
  const edit = wrapLink('see [details]', 4, 13)
  expect(edit.value).toBe('see [\\[details\\]](https://)')
  expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe('https://')
  expect(wrapLink('', 0, 0).value).toBe('[link text](https://)')
})

describe('parseListLine', () => {
  it('reads bullets, ordered items and tasks', () => {
    expect(parseListLine('- hi')).toMatchObject({ kind: 'bullet', bullet: '-', content: 'hi' })
    expect(parseListLine('* hi')).toMatchObject({ kind: 'bullet', bullet: '*' })
    expect(parseListLine('+ hi')).toMatchObject({ kind: 'bullet', bullet: '+' })
    expect(parseListLine('3. hi')).toMatchObject({ kind: 'ordered', number: 3, delim: '.' })
    expect(parseListLine('3) hi')).toMatchObject({ kind: 'ordered', number: 3, delim: ')' })
    expect(parseListLine('- [ ] hi')).toMatchObject({ task: '[ ]', content: 'hi' })
    expect(parseListLine('- [x] hi')).toMatchObject({ task: '[x]', content: 'hi' })
    expect(parseListLine('  - nested')).toMatchObject({ indent: '  ', content: 'nested' })
  })

  it('is not fooled by prose or by an unspaced marker', () => {
    expect(parseListLine('hello')).toBeNull()
    expect(parseListLine('-hello')).toBeNull()
    expect(parseListLine('')).toBeNull()
    expect(parseListLine('1.no space')).toBeNull()
    // A horizontal rule is not a list item.
    expect(parseListLine('---')).toBeNull()
  })

  it('reports the marker width as prefix', () => {
    expect(parseListLine('- [ ] hi')?.prefix).toBe('- [ ] ')
    expect(parseListLine('  12. hi')?.prefix).toBe('  12. ')
  })
})

describe('lineAt', () => {
  it('finds the line around a caret', () => {
    const value = 'one\ntwo\nthree'
    expect(lineAt(value, 0).text).toBe('one')
    expect(lineAt(value, 3).text).toBe('one')
    expect(lineAt(value, 4).text).toBe('two')
    expect(lineAt(value, 13).text).toBe('three')
  })
})

describe('renumber', () => {
  it('makes an ordered run sequential', () => {
    expect(renumber('1. a\n1. b\n1. c')).toBe('1. a\n2. b\n3. c')
  })

  it('keeps the run start the user chose', () => {
    expect(renumber('3. a\n9. b')).toBe('3. a\n4. b')
  })

  it('restarts after a blank line', () => {
    expect(renumber('1. a\n2. b\n\n1. x\n1. y')).toBe('1. a\n2. b\n\n1. x\n2. y')
  })

  it('restarts after prose', () => {
    expect(renumber('1. a\nprose\n5. b\n1. c')).toBe('1. a\nprose\n5. b\n6. c')
  })

  it('counts nested levels separately and resets them on the way out', () => {
    const input = '1. a\n  1. x\n  1. y\n1. b\n  1. p'
    expect(renumber(input)).toBe('1. a\n  1. x\n  2. y\n2. b\n  1. p')
  })

  it('leaves bullets and prose untouched', () => {
    expect(renumber('- a\n- b\nplain')).toBe('- a\n- b\nplain')
  })

  it('preserves the ")" delimiter and task boxes', () => {
    expect(renumber('1) a\n1) b')).toBe('1) a\n2) b')
    expect(renumber('1. [x] a\n1. [ ] b')).toBe('1. [x] a\n2. [ ] b')
  })
})

describe('continueList', () => {
  it('returns null off a list, so Enter still sends', () => {
    const { value, caret } = at('just a prompt|')
    expect(continueList(value, caret)).toBeNull()
  })

  it('continues a bullet', () => {
    const { value, caret } = at('- first|')
    expect(show(continueList(value, caret))).toBe('- first\n- |')
  })

  it('keeps the bullet character the user chose', () => {
    const { value, caret } = at('* first|')
    expect(show(continueList(value, caret))).toBe('* first\n* |')
  })

  it('increments an ordered item and renumbers what follows', () => {
    const { value, caret } = at('1. a|\n2. b')
    const edit = continueList(value, caret)
    expect(edit?.value).toBe('1. a\n2. \n3. b')
    expect(show(edit)).toBe('1. a\n2. |\n3. b')
  })

  it('continues a task unchecked, even from a checked item', () => {
    const { value, caret } = at('- [x] done|')
    expect(show(continueList(value, caret))).toBe('- [x] done\n- [ ] |')
  })

  it('preserves nesting', () => {
    const { value, caret } = at('- a\n  - b|')
    expect(show(continueList(value, caret))).toBe('- a\n  - b\n  - |')
  })

  it('exits the list on an empty item', () => {
    const { value, caret } = at('- a\n- |')
    expect(show(continueList(value, caret))).toBe('- a\n|')
  })

  it('steps out one level before exiting a nested list', () => {
    const { value, caret } = at('- a\n  - |')
    expect(show(continueList(value, caret))).toBe('- a\n- |')
  })

  it('does nothing mid-marker, so the caret cannot split "1." in half', () => {
    const value = '1. abc'
    expect(continueList(value, 1)).toBeNull()
  })

  it('splits an item when the caret sits inside the content', () => {
    const edit = continueList('- abcd', 4)
    expect(show(edit)).toBe('- ab\n- |cd')
  })
})

describe('toggleList', () => {
  it('adds bullets to plain lines', () => {
    const value = 'a\nb'
    const edit = toggleList(value, 0, value.length, 'bullet')
    expect(edit.value).toBe('- a\n- b')
  })

  it('removes bullets when every line already has one', () => {
    const value = '- a\n- b'
    expect(toggleList(value, 0, value.length, 'bullet').value).toBe('a\nb')
  })

  it('converts bullets to a numbered list', () => {
    const value = '- a\n- b\n- c'
    expect(toggleList(value, 0, value.length, 'ordered').value).toBe('1. a\n2. b\n3. c')
  })

  it('converts a numbered list to bullets', () => {
    const value = '1. a\n2. b'
    expect(toggleList(value, 0, value.length, 'bullet').value).toBe('- a\n- b')
  })

  it('normalises a mixed selection to one kind', () => {
    const value = '- a\nplain\n2. c'
    expect(toggleList(value, 0, value.length, 'bullet').value).toBe('- a\n- plain\n- c')
  })

  it('leaves blank lines alone', () => {
    const value = 'a\n\nb'
    expect(toggleList(value, 0, value.length, 'bullet').value).toBe('- a\n\n- b')
  })

  it('keeps the checkbox when swapping marker kind', () => {
    const value = '- [x] a'
    expect(toggleList(value, 0, value.length, 'ordered').value).toBe('1. [x] a')
  })

  it('seeds a marker on an empty composer', () => {
    const edit = toggleList('', 0, 0, 'ordered')
    expect(edit.value).toBe('1. ')
    expect(edit.selectionStart).toBe(3)
  })

  it('only touches the selected lines', () => {
    const value = 'keep\na\nb'
    const from = value.indexOf('a')
    const edit = toggleList(value, from, value.length, 'bullet')
    expect(edit.value).toBe('keep\n- a\n- b')
  })
})

describe('indentSelection', () => {
  it('returns null when nothing selected is a list item', () => {
    expect(indentSelection('plain text', 0, 5, 'in')).toBeNull()
  })

  it('indents and renumbers the nested level', () => {
    const value = '1. a\n2. b'
    const from = value.indexOf('2.')
    const edit = indentSelection(value, from, value.length, 'in')
    expect(edit?.value).toBe('1. a\n  1. b')
  })

  it('outdents back', () => {
    const value = '1. a\n  1. b'
    const from = value.indexOf('  1.')
    const edit = indentSelection(value, from, value.length, 'out')
    expect(edit?.value).toBe('1. a\n2. b')
  })

  it('is a no-op outdenting a top-level item', () => {
    const value = '- a'
    expect(indentSelection(value, 0, value.length, 'out')?.value).toBe('- a')
  })

  it('moves the selection with the text', () => {
    const value = '- a'
    const edit = indentSelection(value, 2, 3, 'in')
    expect(edit?.selectionStart).toBe(4)
    expect(edit?.selectionEnd).toBe(5)
  })
})

describe('wrapSelection', () => {
  it('wraps a selection', () => {
    const edit = wrapSelection('make me bold', 8, 12, '**')
    expect(edit.value).toBe('make me **bold**')
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe('bold')
  })

  it('unwraps when the markers are already outside', () => {
    const value = 'make me **bold**'
    const from = value.indexOf('bold')
    const edit = wrapSelection(value, from, from + 4, '**')
    expect(edit.value).toBe('make me bold')
  })

  it('unwraps when the markers are inside the selection', () => {
    const value = 'make me **bold**'
    const edit = wrapSelection(value, 8, value.length, '**')
    expect(edit.value).toBe('make me bold')
  })

  it('inserts an empty pair with the caret between', () => {
    const edit = wrapSelection('hi ', 3, 3, '_')
    expect(edit.value).toBe('hi __')
    expect(edit.selectionStart).toBe(4)
    expect(edit.selectionEnd).toBe(4)
  })
})

describe('wrapCodeBlock', () => {
  it('fences the selection on its own lines', () => {
    const edit = wrapCodeBlock('run npm test now', 4, 12)
    expect(edit.value).toBe('run \n```\nnpm test\n```\n now')
  })

  it('does not add a leading newline at the start of the value', () => {
    const edit = wrapCodeBlock('npm test', 0, 8)
    expect(edit.value).toBe('```\nnpm test\n```')
  })
})

describe('pasteIntoList', () => {
  it('ignores single-line pastes', () => {
    expect(pasteIntoList('- a', 3, 'one line')).toBeNull()
  })

  it('ignores pastes outside a list', () => {
    expect(pasteIntoList('prose', 5, 'a\nb')).toBeNull()
  })

  it('marks every pasted line with the current bullet', () => {
    const edit = pasteIntoList('- ', 2, 'a\nb\nc')
    expect(edit?.value).toBe('- a\n- b\n- c')
  })

  it('renumbers an ordered paste', () => {
    const edit = pasteIntoList('1. ', 3, 'a\nb\nc')
    expect(edit?.value).toBe('1. a\n2. b\n3. c')
  })

  it('leaves text that is already a list alone', () => {
    expect(pasteIntoList('- ', 2, '- a\n- b')).toBeNull()
  })

  it('keeps blank lines blank', () => {
    const edit = pasteIntoList('- ', 2, 'a\n\nb')
    expect(edit?.value).toBe('- a\n\n- b')
  })
})
