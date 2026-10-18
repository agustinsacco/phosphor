import { describe, it, expect } from 'vitest'
import { commandScore, fuzzyMatch, fuzzyFilter } from './fuzzy'

describe('fuzzyMatch', () => {
  it('scores an empty query as 0 without inspecting the target', () => {
    expect(fuzzyMatch('', 'anything')).toBe(0)
  })

  it('returns null when the query is not a subsequence of the target', () => {
    expect(fuzzyMatch('xyz', 'abc')).toBeNull()
    expect(fuzzyMatch('abcd', 'abc')).toBeNull()
  })

  it('matches a subsequence that is not contiguous', () => {
    expect(fuzzyMatch('ac', 'abc')).not.toBeNull()
  })

  it('is case-insensitive in both directions', () => {
    expect(fuzzyMatch('ABC', 'abc')).toBe(fuzzyMatch('abc', 'ABC'))
  })

  it('rewards contiguous runs over scattered matches', () => {
    const contiguous = fuzzyMatch('abc', 'abcxxxxx')!
    const scattered = fuzzyMatch('abc', 'axbxcxxx')!
    expect(contiguous).toBeGreaterThan(scattered)
  })

  it('rewards matches at path and word boundaries', () => {
    const boundary = fuzzyMatch('f', 'src/foo')!
    const midWord = fuzzyMatch('f', 'srcxfoo'.replace('foo', 'oof'))!
    expect(boundary).toBeGreaterThan(midWord)
  })

  it('treats /, -, _ and . as boundaries', () => {
    for (const sep of ['/', '-', '_', '.']) {
      expect(fuzzyMatch('b', `a${sep}b`)!).toBeGreaterThan(fuzzyMatch('b', 'axb')!)
    }
  })

  it('penalizes longer targets', () => {
    const short = fuzzyMatch('abc', 'abc')!
    const long = fuzzyMatch('abc', 'abc' + 'x'.repeat(80))!
    expect(short).toBeGreaterThan(long)
  })

  it('gives a basename bonus when the first query char appears after the last slash', () => {
    const inBasename = fuzzyMatch('z', 'aaa/zzz')!
    const inDirOnly = fuzzyMatch('z', 'zzz/aaa')!
    expect(inBasename).toBeGreaterThan(inDirOnly)
  })
})

describe('fuzzyFilter', () => {
  const items = ['src/app/App.tsx', 'src/lib/fuzzy.ts', 'README.md']
  const identity = (s: string): string => s

  it('returns the head of the list unfiltered for an empty query', () => {
    expect(fuzzyFilter('', items, identity)).toEqual(items)
  })

  it('respects the limit when the query is empty', () => {
    expect(fuzzyFilter('', items, identity, 2)).toEqual(items.slice(0, 2))
  })

  it('drops non-matching items', () => {
    expect(fuzzyFilter('fuzzy', items, identity)).toEqual(['src/lib/fuzzy.ts'])
  })

  it('orders results by descending score', () => {
    const result = fuzzyFilter('app', ['zzz/app-thing', 'src/app/App.tsx'], identity)
    expect(result.length).toBe(2)
    // Both match; the ordering is score-driven, not input-driven.
    const scores = result.map((r) => fuzzyMatch('app', r)!)
    expect(scores[0]!).toBeGreaterThanOrEqual(scores[1]!)
  })

  it('caps the number of results at the limit', () => {
    const many = Array.from({ length: 100 }, (_, i) => `file${i}.ts`)
    expect(fuzzyFilter('file', many, identity, 10).length).toBe(10)
  })

  it('uses the key selector to read the match target', () => {
    const objects = [{ path: 'src/lib/fuzzy.ts' }, { path: 'README.md' }]
    expect(fuzzyFilter('fuzzy', objects, (o) => o.path)).toEqual([{ path: 'src/lib/fuzzy.ts' }])
  })
})

describe('commandScore', () => {
  it('matches everything on an empty query', () => {
    expect(commandScore('', 'anything')).toBe(0)
  })

  it('returns null when neither the name nor the description contains the query', () => {
    expect(commandScore('xyz', 'mcp', 'Show MCP server status')).toBeNull()
  })

  it('puts an exact name above every prefix, and a prefix above a segment', () => {
    const exact = commandScore('mcp', 'mcp')!
    const prefix = commandScore('mcp', 'mcp-auth')!
    const longPrefix = commandScore('mcp', 'mcp__notion__make-this-a-notion-page')!
    const segment = commandScore('mcp', 'pi-mcp')!
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(longPrefix)
    expect(longPrefix).toBeGreaterThan(segment)
  })

  it('treats the colon in skill:<name> as a word boundary', () => {
    // The bare skill name is a whole segment — the same tier `pi-mcp` gets for
    // `mcp`, and far above a scattered subsequence.
    const skill = commandScore('debug', 'skill:debug')!
    const scattered = commandScore('debug', 'do-eat-bagels-ugh')!
    expect(skill).toBeGreaterThan(scattered)
    // Same tier, same length → same score as a `-` boundary.
    expect(skill).toBe(commandScore('debug', 'xxxxx-debug')!)
  })

  it('prefers the shorter name within a tier', () => {
    expect(commandScore('e2e', 'skill:e2e')!).toBeGreaterThan(
      commandScore('e2e', 'skill:test-augie-e2e-slack')!,
    )
  })

  it('ranks a segment prefix above a subsequence', () => {
    expect(commandScore('scr', 'skill:mcp-scripting')!).toBeGreaterThan(
      commandScore('scr', 'search-curator')!,
    )
  })

  it('falls back to the description, below any name match', () => {
    const fromDescription = commandScore('status', 'mcp', 'Show MCP server status')!
    expect(fromDescription).toBe(100)
    expect(fromDescription).toBeLessThan(commandScore('status', 'x-s-t-a-t-u-s')!)
    expect(commandScore('STATUS', 'mcp', 'Show MCP server status')).toBe(100)
  })

  it('keeps a long scattered match out of the segment band', () => {
    const scattered = commandScore(
      'abcdefghijklmnopqrst',
      'a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t',
    )!
    expect(scattered).toBeLessThan(500)
  })

  it('is case-insensitive', () => {
    expect(commandScore('MCP', 'mcp')).toBe(1000)
    expect(commandScore('mcp', 'MCP')).toBe(1000)
  })
})
