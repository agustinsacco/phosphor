import { describe, it, expect } from 'vitest'
import { artifactUrlTransform, classifyLink } from './markdownLink'

describe('classifyLink', () => {
  it('sends web URLs to the browser', () => {
    expect(classifyLink('https://github.com/agustinsacco/Phosphor/pull/214')).toEqual({
      kind: 'external',
      url: 'https://github.com/agustinsacco/Phosphor/pull/214',
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
    expect(classifyLink('/Users/u/phosphor/CLAUDE.md')).toEqual({
      kind: 'file',
      path: '/Users/u/phosphor/CLAUDE.md',
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

  it('reads an artifact link the model wrote', () => {
    expect(classifyLink('artifact://phosphor-beacon')).toEqual({
      kind: 'artifact',
      id: 'phosphor-beacon',
    })
    expect(classifyLink('artifact:phosphor-beacon')).toEqual({
      kind: 'artifact',
      id: 'phosphor-beacon',
    })
  })

  it('slugifies an artifact id written as a title', () => {
    expect(classifyLink('artifact://Phosphor%20Beacon')).toEqual({
      kind: 'artifact',
      id: 'phosphor-beacon',
    })
  })

  it('opens the version an artifact link names', () => {
    expect(classifyLink('artifact://phosphor-beacon#v2')).toEqual({
      kind: 'artifact',
      id: 'phosphor-beacon',
      version: 2,
    })
    expect(classifyLink('artifact://phosphor-beacon@v3')).toEqual({
      kind: 'artifact',
      id: 'phosphor-beacon',
      version: 3,
    })
  })

  it('drops a heading fragment on an artifact link', () => {
    expect(classifyLink('artifact://phosphor-beacon#risks')).toEqual({
      kind: 'artifact',
      id: 'phosphor-beacon',
    })
  })

  it('has nothing to open for an artifact link with no id', () => {
    expect(classifyLink('artifact://')).toEqual({ kind: 'none' })
  })

  it('refuses schemes that are not http(s), file or artifact', () => {
    expect(classifyLink('mailto:a@b.com')).toEqual({ kind: 'none' })
    expect(classifyLink('javascript:alert(1)')).toEqual({ kind: 'none' })
    expect(classifyLink('phosphor-artifact://x')).toEqual({ kind: 'none' })
  })

  it('does nothing for in-document anchors and empty hrefs', () => {
    expect(classifyLink('#risks-top-first')).toEqual({ kind: 'anchor' })
    expect(classifyLink('   ')).toEqual({ kind: 'none' })
    expect(classifyLink('./')).toEqual({ kind: 'none' })
  })
})

describe('artifactUrlTransform', () => {
  it('lets an artifact link reach the component', () => {
    // react-markdown's own filter returned '' for these, so the classifier
    // never got a chance and every artifact link in chat was a dead end.
    expect(artifactUrlTransform('artifact://phosphor-beacon')).toBe('artifact://phosphor-beacon')
    expect(artifactUrlTransform('artifact:phosphor-beacon#v2')).toBe('artifact:phosphor-beacon#v2')
  })

  it('keeps stripping the schemes react-markdown refuses', () => {
    expect(artifactUrlTransform('javascript:alert(1)')).toBe('')
    expect(artifactUrlTransform('vbscript:x')).toBe('')
  })

  it('leaves web URLs and repo paths alone', () => {
    expect(artifactUrlTransform('https://github.com/o/r/pull/214')).toBe(
      'https://github.com/o/r/pull/214',
    )
    expect(artifactUrlTransform('docs/plan.md#L42')).toBe('docs/plan.md#L42')
  })
})
