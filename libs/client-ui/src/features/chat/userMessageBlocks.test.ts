import { describe, expect, it } from 'vitest'
import { parseUserText } from './userMessageBlocks'

describe('parseUserText', () => {
  it('keeps plain prose as one text block', () => {
    expect(parseUserText('hello\nthere')).toEqual([{ kind: 'text', text: 'hello\nthere' }])
  })

  it('promotes a bullet run to a list', () => {
    expect(parseUserText('- a\n- b')).toEqual([
      {
        kind: 'list',
        listKind: 'bullet',
        start: 1,
        items: [
          { content: 'a', depth: 0, checked: null },
          { content: 'b', depth: 0, checked: null },
        ],
      },
    ])
  })

  it('keeps the number an ordered run starts at', () => {
    const [block] = parseUserText('3. a\n4. b')
    expect(block).toMatchObject({ kind: 'list', listKind: 'ordered', start: 3 })
  })

  it('splits prose around a list', () => {
    const blocks = parseUserText('do this:\n- a\n- b\nthanks')
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'list', 'text'])
    expect(blocks[0]).toEqual({ kind: 'text', text: 'do this:' })
    expect(blocks[2]).toEqual({ kind: 'text', text: 'thanks' })
  })

  it('starts a new block when the list kind changes', () => {
    const blocks = parseUserText('- a\n1. b')
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'list'])
  })

  it('reads nesting depth in two-space steps', () => {
    const [block] = parseUserText('- a\n  - b\n    - c')
    expect(block).toMatchObject({
      items: [
        { content: 'a', depth: 0 },
        { content: 'b', depth: 1 },
        { content: 'c', depth: 2 },
      ],
    })
  })

  it('reads task checkboxes', () => {
    const [block] = parseUserText('- [ ] todo\n- [x] done')
    expect(block).toMatchObject({
      items: [
        { content: 'todo', checked: false },
        { content: 'done', checked: true },
      ],
    })
  })

  it('leaves the attached-files block as literal text', () => {
    const text = 'look at this\n\n<attached-files>\n/tmp/a.pdf\n</attached-files>'
    expect(parseUserText(text)).toEqual([{ kind: 'text', text }])
  })

  it('handles an empty message', () => {
    expect(parseUserText('')).toEqual([{ kind: 'text', text: '' }])
  })
})
