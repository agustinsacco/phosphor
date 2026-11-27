import { describe, expect, it } from 'vitest'
import { isInsideResolved as inside } from '@phosphor/session-runtime/fs-safety'

// The lexical containment the Host's archive, delete and file routes share:
// both paths are resolved, the root itself counts, and only whole segments do.
describe('Host lane containment', () => {
  it.each<[string, string, boolean]>([
    ['/repo', '/repo', true],
    ['/repo', '/repo/', true],
    ['/repo/', '/repo/a', true],
    ['/repo', '/repo/a/b', true],
    ['/repo', '/repo/..notes', true],
    ['/repo', '/repo/a/../b', true],
    ['/repo', '/repo/../etc', false],
    ['/repo', '/repo-sibling', false],
    ['/repo', '/rep', false],
    ['/repo', '/', false],
    ['/', '/anything', true],
    ['/', '/', true],
  ])('inside(%s, %s) is %s', (root, path, expected) => {
    expect(inside(root, path)).toBe(expected)
  })

  it('resolves relative paths against the working directory', () => {
    expect(inside('.', 'a/b')).toBe(true)
    expect(inside('a', '.')).toBe(false)
  })
})
