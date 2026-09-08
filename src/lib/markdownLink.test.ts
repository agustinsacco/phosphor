import { describe, it, expect } from 'vitest'
import { classifyLink } from './markdownLink'

describe('classifyLink', () => {
  it('sends web URLs to the browser', () => {
    expect(classifyLink('https://github.com/agustinsacco/pidex/pull/214')).toEqual({
      kind: 'external',
      url: 'https://github.com/agustinsacco/pidex/pull/214',
    })
    expect(classifyLink('http://localhost:5173/x')).toEqual({
      kind: 'external',
      url: 'http://localhost:5173/x',
    })
  })

  it('treats a schemeless link as a repo path', () => {
    expect(classifyLink('docs/specs/headroom-compression.md')).toEqual({
      kind: 'file',
      path: 'docs/specs/headroom-compression.md',
    })
    expect(classifyLink('./README.md')).toEqual({ kind: 'file', path: 'README.md' })
    expect(classifyLink('../shared/rpc.ts')).toEqual({ kind: 'file', path: '../shared/rpc.ts' })
    expect(classifyLink('/Users/u/pidex/CLAUDE.md')).toEqual({
      kind: 'file',
      path: '/Users/u/pidex/CLAUDE.md',
    })
  })

  it('reads a line from either convention', () => {
    expect(classifyLink('src/lib/rpc.ts#L42')).toEqual({
      kind: 'file',
      path: 'src/lib/rpc.ts',
      line: 42,
    })
    expect(classifyLink('src/lib/rpc.ts:42')).toEqual({
      kind: 'file',
      path: 'src/lib/rpc.ts',
      line: 42,
    })
    expect(classifyLink('src/lib/rpc.ts:42:7')).toEqual({
      kind: 'file',
      path: 'src/lib/rpc.ts',
      line: 42,
    })
  })

  it('drops a heading fragment that is not a line', () => {
    expect(classifyLink('docs/README.md#repo-layout')).toEqual({
      kind: 'file',
      path: 'docs/README.md',
    })
  })

  it('decodes file: URLs and percent escapes', () => {
    expect(classifyLink('file:///Users/u/my%20repo/a.md')).toEqual({
      kind: 'file',
      path: '/Users/u/my repo/a.md',
    })
    expect(classifyLink('my%20notes.md')).toEqual({ kind: 'file', path: 'my notes.md' })
    expect(classifyLink('100%.md')).toEqual({ kind: 'file', path: '100%.md' })
  })

  it('keeps a Windows drive letter out of the scheme check', () => {
    expect(classifyLink('C:\\repo\\src\\a.ts')).toEqual({
      kind: 'file',
      path: 'C:\\repo\\src\\a.ts',
    })
  })

  it('refuses schemes that are not http(s) or file', () => {
    expect(classifyLink('mailto:a@b.com')).toEqual({ kind: 'none' })
    expect(classifyLink('javascript:alert(1)')).toEqual({ kind: 'none' })
    expect(classifyLink('pidex-artifact://x')).toEqual({ kind: 'none' })
  })

  it('does nothing for in-document anchors and empty hrefs', () => {
    expect(classifyLink('#risks-top-first')).toEqual({ kind: 'anchor' })
    expect(classifyLink('   ')).toEqual({ kind: 'none' })
    expect(classifyLink('./')).toEqual({ kind: 'none' })
  })
})
