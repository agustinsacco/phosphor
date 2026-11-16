export interface DiffLine {
  kind: 'same' | 'removed' | 'added'
  text: string
}

const lines = (text: string): string[] =>
  text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n')

/**
 * A line comparison with shared context. Bound the LCS matrix: large unrelated versions
 * show the changed middle as one replacement rather than blocking a phone on quadratic work.
 */
export function unifiedLines(original: string, modified: string): DiffLine[] {
  const before = lines(original)
  const after = lines(modified)
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++
  const a = before.slice(start, before.length - end)
  const b = after.slice(start, after.length - end)
  let result: DiffLine[] = before.slice(0, start).map((text) => ({ kind: 'same', text }))
  if ((a.length + 1) * (b.length + 1) > 250_000) {
    result = result.concat(
      a.map((text) => ({ kind: 'removed', text })),
      b.map((text) => ({ kind: 'added', text })),
    )
  } else {
    const width = b.length + 1
    const lcs = new Uint32Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        lcs[i * width + j] =
          a[i] === b[j]
            ? 1 + lcs[(i + 1) * width + j + 1]!
            : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        result.push({ kind: 'same', text: a[i++]! })
        j++
      } else if (
        i < a.length &&
        (j === b.length || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)
      )
        result.push({ kind: 'removed', text: a[i++]! })
      else result.push({ kind: 'added', text: b[j++]! })
    }
  }
  return result.concat(before.slice(before.length - end).map((text) => ({ kind: 'same', text })))
}
