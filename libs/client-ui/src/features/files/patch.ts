/**
 * Minimal unified-patch utilities for the Files Changed panel fallback
 * (non-git workspaces): reconstruct a file's session-start content by
 * reverse-applying the session's patches (newest first).
 */

interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseUnifiedPatch(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      current = {
        oldStart: parseInt(header[1]!, 10),
        oldLines: header[2] ? parseInt(header[2], 10) : 1,
        newStart: parseInt(header[3]!, 10),
        newLines: header[4] ? parseInt(header[4], 10) : 1,
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '') {
      // Trailing empty line in a patch is context for a final newline.
      current.lines.push(line)
    }
  }
  return hunks
}

/**
 * Reverse-apply one unified patch: given the NEW content, return the OLD.
 * Works hunk-by-hunk using the new-side line numbers.
 */
export function reverseApplyPatch(newContent: string, patch: string): string {
  const hunks = parseUnifiedPatch(patch)
  if (hunks.length === 0) return newContent

  const newLines = newContent.split('\n')
  const oldLines: string[] = []
  let newIndex = 0 // 0-based cursor into newLines

  for (const hunk of hunks) {
    const hunkNewStart = hunk.newStart - 1
    // Copy untouched region before the hunk.
    while (newIndex < hunkNewStart && newIndex < newLines.length) {
      oldLines.push(newLines[newIndex]!)
      newIndex++
    }
    for (const line of hunk.lines) {
      const marker = line[0]
      const text = line.slice(1)
      if (marker === ' ') {
        oldLines.push(text)
        newIndex++
      } else if (marker === '+') {
        // Present in new, absent in old: skip in new.
        newIndex++
      } else if (marker === '-') {
        // Absent in new, present in old: restore.
        oldLines.push(text)
      }
    }
  }
  // Copy the tail.
  while (newIndex < newLines.length) {
    oldLines.push(newLines[newIndex]!)
    newIndex++
  }
  return oldLines.join('\n')
}

/** Reverse-apply a chain of patches (oldest→newest order) to current content. */
export function reconstructOriginal(currentContent: string, patchesOldestFirst: string[]): string {
  let content = currentContent
  for (let i = patchesOldestFirst.length - 1; i >= 0; i--) {
    content = reverseApplyPatch(content, patchesOldestFirst[i]!)
  }
  return content
}
