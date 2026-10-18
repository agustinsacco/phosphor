import { describe, expect, it } from 'vitest'
import { parseUnifiedPatch, reverseApplyPatch, reconstructOriginal } from './patch'

const OLD = 'line one\nline two\nline three\nline four\nline five'
const NEW = 'line one\nline TWO changed\nline three\nline four\nline five\nline six'

// Matches pi's generateUnifiedPatch output shape.
const PATCH = `--- a/file.txt
+++ b/file.txt
@@ -1,5 +1,6 @@
 line one
-line two
+line TWO changed
 line three
 line four
 line five
+line six`

describe('unified patch utilities', () => {
  it('parses hunks', () => {
    const hunks = parseUnifiedPatch(PATCH)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 5, newStart: 1, newLines: 6 })
  })

  it('reverse-applies a patch to recover the old content', () => {
    expect(reverseApplyPatch(NEW, PATCH)).toBe(OLD)
  })

  it('handles multi-hunk patches', () => {
    const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
    const patched = ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'I', 'j'].join('\n')
    const patch = `@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -8,3 +8,3 @@
 h
-i
+I
 j`
    expect(reverseApplyPatch(patched, patch)).toBe(old)
  })

  it('reconstructs the original through a chain of patches', () => {
    const v1 = 'alpha\nbeta'
    const v2 = 'alpha\nbeta\ngamma'
    const v3 = 'alpha\nBETA\ngamma'
    const patch1 = `@@ -1,2 +1,3 @@
 alpha
 beta
+gamma`
    const patch2 = `@@ -1,3 +1,3 @@
 alpha
-beta
+BETA
 gamma`
    expect(reverseApplyPatch(v3, patch2)).toBe(v2)
    expect(reconstructOriginal(v3, [patch1, patch2])).toBe(v1)
  })

  it('returns content unchanged for empty patches', () => {
    expect(reverseApplyPatch('x\ny', '')).toBe('x\ny')
  })
})
