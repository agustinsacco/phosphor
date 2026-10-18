import { describe, expect, it } from 'vitest'
import { markdownText } from './markdownText'

describe('markdownText', () => {
  it('drops emphasis, links and inline code syntax', () => {
    expect(markdownText('Use **bold**, *em*, ~~old~~ and `a*b*c` [docs](https://x.dev/a)')).toBe(
      'Use bold, em, old and a*b*c docs',
    )
  })

  it('keeps underscores inside words', () => {
    expect(markdownText('call snake_case_name or _this_')).toBe('call snake_case_name or this')
  })

  it('keeps fenced code verbatim and drops the fences', () => {
    expect(markdownText('Before\n```ts\nconst a = **b**\n```\nAfter')).toBe(
      'Before\nconst a = **b**\nAfter',
    )
  })

  it('strips block prefixes: headings, quotes, list markers, task boxes', () => {
    expect(markdownText('## Title ##\n> quoted\n- [x] done\n12. twelve')).toBe(
      'Title\nquoted\ndone\ntwelve',
    )
  })

  it('splits table rows into cells and drops the delimiter row', () => {
    expect(markdownText('| a | **b** |\n|---|:-:|\n| 1 | 2 |')).toBe('a\nb\n\n1\n2')
  })

  it('drops images, keeps raw html as the text it shows as, decodes entities', () => {
    expect(markdownText('![shot](a.png) x<br/>y &amp; &#65;')).toBe(' x<br/>y & A')
  })

  it('reads a backslash escape as its character, before emphasis can take it', () => {
    expect(markdownText('\\*not em\\* and \\_x\\_')).toBe('*not em* and _x_')
  })

  it('allows balanced parentheses in a link destination', () => {
    expect(markdownText('[f](https://a.dev/f_(x)) done')).toBe('f done')
  })

  it('joins soft line breaks with a space, and ends a line at a hard break', () => {
    expect(markdownText('one\ntwo  \nthree\\\nfour')).toBe('one two\nthree\nfour')
  })

  it('drops math, inline and in blocks', () => {
    expect(markdownText('a $x^2$ b\n$$\nE=mc^2\n$$\nc')).toBe('a  b\nc')
  })

  it('treats thematic breaks and setext underlines as empty lines', () => {
    expect(markdownText('Head\n===\n---\n* * *')).toBe('Head\n\n\n')
  })
})
