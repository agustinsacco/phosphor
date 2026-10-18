// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { compileQuery, DEFAULT_SEARCH_OPTIONS, type SearchQuery } from '@shared/text-search'
import { findRanges, indexText } from './domFind'

function dom(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

function regexFor(text: string, options: Partial<SearchQuery> = {}): RegExp {
  const compiled = compileQuery({ ...DEFAULT_SEARCH_OPTIONS, text, ...options })
  if (compiled.status !== 'ready') throw new Error(`not ready: ${compiled.status}`)
  return compiled.regex
}

describe('indexText', () => {
  it('joins inline text and breaks lines at block edges', () => {
    const root = dom('<p>one <strong>two</strong></p><p>three</p><ul><li>a</li><li>b</li></ul>')
    expect(indexText(root).text).toBe('one two\nthree\na\nb\n')
  })

  it('skips hidden, screen-reader and opted-out subtrees', () => {
    const root = dom(
      '<p>shown</p><p aria-hidden="true">aria</p><span class="sr-only">sr</span>' +
        '<span data-find-skip>chrome</span><p hidden>hidden</p><textarea>field</textarea>',
    )
    expect(indexText(root).text).toBe('shown\n')
  })
})

describe('findRanges', () => {
  it('maps a match spanning several inline nodes back to one range', () => {
    const root = dom('<pre><span>con</span><span>st</span> x</pre>')
    const [range] = findRanges(root, regexFor('const x'), 10)
    expect(range!.toString()).toBe('const x')
    expect(range!.startContainer.textContent).toBe('con')
    expect(range!.endContainer.textContent).toBe(' x')
  })

  it('never matches across two blocks that merely touch', () => {
    const root = dom('<p>foo</p><p>bar</p>')
    expect(findRanges(root, regexFor('foobar'), 10)).toEqual([])
  })

  it('trims a regex match that swallows a block break to real text', () => {
    const root = dom('<p>foo</p><p>bar</p>')
    const ranges = findRanges(root, regexFor('foo\\n', { regex: true }), 10)
    expect(ranges.map((range) => range.toString())).toEqual(['foo'])
    const across = findRanges(root, regexFor('o\\nb', { regex: true }), 10)
    expect(across.map((range) => range.toString())).toEqual(['ob'])
  })

  it('stops at the limit', () => {
    const root = dom('<p>a a a a</p>')
    expect(findRanges(root, regexFor('a'), 3)).toHaveLength(3)
  })
})
