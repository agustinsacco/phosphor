/**
 * Parser for pi's display diff format (EditToolDetails.diff):
 * each line is `<marker><lineNo> <content>` where marker is ' ', '-', or '+'
 * e.g. " 1 line one" / "-2 line two" / "+2 line TWO changed".
 *
 * pi left-pads the number to the width of the file's largest line number, so
 * in a 100+ line file an early change reads "+ 18 text". The pattern must
 * allow that padding: without it every line fell through as context, and the
 * Changes pane counted "+0 -0" for any edit in a long file.
 */

export interface DiffLine {
  kind: 'context' | 'del' | 'add'
  lineNo: number | null
  text: string
}

export interface DiffStats {
  additions: number
  deletions: number
}

const DIFF_LINE = /^([ +-]) *(\d+)\s(.*)$/s
const DIFF_LINE_BARE = /^([ +-]) *(\d+)$/

export function parseDisplayDiff(diff: string): DiffLine[] {
  if (!diff) return []
  return diff.split('\n').map((raw) => {
    const match = DIFF_LINE.exec(raw) ?? DIFF_LINE_BARE.exec(raw)
    if (!match) {
      return { kind: 'context' as const, lineNo: null, text: raw }
    }
    const [, marker, lineNo, text = ''] = match
    const kind =
      marker === '+' ? ('add' as const) : marker === '-' ? ('del' as const) : ('context' as const)
    return { kind, lineNo: parseInt(lineNo!, 10), text }
  })
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.kind === 'add') additions++
    else if (line.kind === 'del') deletions++
  }
  return { additions, deletions }
}

/** Stats from a unified patch (fallback when only `patch` is present). */
export function unifiedPatchStats(patch: string): DiffStats {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}
