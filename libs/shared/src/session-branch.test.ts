import { describe, expect, it } from 'vitest'
import { sessionBranch } from './session-branch'

describe('sessionBranch', () => {
  it('defaults to an empty branch for an unknown leaf or a cycle', () => {
    const entries = [{ id: 'self', parentId: 'self' }]
    expect(sessionBranch(entries, 'unknown')).toEqual([])
    expect(sessionBranch(entries, 'self')).toEqual([])
  })

  describe.each(['empty', 'last'] as const)('unknownLeaf=%s', (mode) => {
    it('returns no branch for a null leaf, even with entries present', () => {
      expect(sessionBranch([{ id: 'root', parentId: null }], null, mode)).toEqual([])
    })

    it('returns no branch from an empty list', () => {
      expect(sessionBranch([], null, mode)).toEqual([])
      expect(sessionBranch([], 'unknown', mode)).toEqual([])
    })

    it('follows parents root-to-leaf regardless of array order, preserving references and input', () => {
      const root = Object.freeze({ id: 'root', parentId: null, text: 'root payload' })
      const middle = Object.freeze({ id: 'middle', parentId: 'root', text: 'middle payload' })
      const leaf = Object.freeze({ id: 'leaf', parentId: 'middle', text: 'leaf payload' })
      const sibling = Object.freeze({ id: 'sibling', parentId: 'root', text: 'not selected' })
      const entries = [leaf, sibling, root, middle]
      Object.freeze(entries)

      const branch = sessionBranch(entries, 'leaf', mode)

      expect(branch).toEqual([root, middle, leaf])
      expect(branch[0]).toBe(root)
      expect(branch[1]).toBe(middle)
      expect(branch[2]).toBe(leaf)
      expect(branch).not.toBe(entries)
      expect(entries).toEqual([leaf, sibling, root, middle])
    })

    it('returns only the root when the selected leaf is a root', () => {
      const root = { id: 'root', parentId: null }
      expect(sessionBranch([root, { id: 'child', parentId: 'root' }], 'root', mode)).toEqual([root])
    })

    it('uses the last occurrence of duplicate leaf and parent IDs', () => {
      const oldRoot = { id: 'root', parentId: 'missing', text: 'old root' }
      const oldLeaf = { id: 'leaf', parentId: 'missing', text: 'old leaf' }
      const root = { id: 'root', parentId: null, text: 'last root' }
      const leaf = { id: 'leaf', parentId: 'root', text: 'last leaf' }

      const branch = sessionBranch([oldRoot, oldLeaf, root, leaf], 'leaf', mode)

      expect(branch).toEqual([root, leaf])
      expect(branch[0]).toBe(root)
      expect(branch[1]).toBe(leaf)
    })

    it('keeps the available path when a parent is missing', () => {
      const orphan = { id: 'orphan', parentId: 'missing' }
      const leaf = { id: 'leaf', parentId: 'orphan' }
      const unrelated = { id: 'root', parentId: null }
      expect(sessionBranch([leaf, unrelated, orphan], 'leaf', mode)).toEqual([orphan, leaf])
      expect(sessionBranch([orphan], 'orphan', mode)).toEqual([orphan])
    })

    it('terminates at a self-cycle, discarding it only in empty mode', () => {
      const self = { id: 'self', parentId: 'self' }
      expect(sessionBranch([self], 'self', mode)).toEqual(mode === 'empty' ? [] : [self])
    })

    it('terminates at a multi-node cycle without repeating an entry', () => {
      const a = { id: 'a', parentId: 'b' }
      const b = { id: 'b', parentId: 'a' }
      const leaf = { id: 'leaf', parentId: 'a' }
      expect(sessionBranch([b, leaf, a], 'leaf', mode)).toEqual(
        mode === 'empty' ? [] : [b, a, leaf],
      )
    })

    it('uses the last array entry for an unknown leaf only in last mode', () => {
      const root = { id: 'root', parentId: null }
      const leaf = { id: 'leaf', parentId: 'root' }
      const last = { id: 'last', parentId: 'root' }
      expect(sessionBranch([leaf, root, last], 'unknown', mode)).toEqual(
        mode === 'empty' ? [] : [root, last],
      )
    })
  })

  it('starts last fallback at the actual last entry, then resolves parents by last ID', () => {
    const oldRoot = { id: 'root', parentId: null, text: 'old root' }
    const root = { id: 'root', parentId: 'missing', text: 'last root' }
    const leaf = { id: 'leaf', parentId: 'root', text: 'last entry' }
    const branch = sessionBranch([oldRoot, root, leaf], 'unknown', 'last')
    expect(branch).toEqual([root, leaf])
    expect(branch[0]).toBe(root)
    expect(branch[1]).toBe(leaf)
  })

  it('last fallback also terminates cycles and retains the reversed unique path', () => {
    const a = { id: 'a', parentId: 'b' }
    const b = { id: 'b', parentId: 'a' }
    expect(sessionBranch([a, b], 'unknown', 'last')).toEqual([a, b])
    expect(sessionBranch([{ id: 'self', parentId: 'self' }], 'unknown', 'last')).toEqual([
      { id: 'self', parentId: 'self' },
    ])
  })
})
