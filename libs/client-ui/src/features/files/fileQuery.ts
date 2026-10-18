/** A filename query may end with a 1-based line and optional column. */
export function parseFileQuery(query: string): {
  path: string
  target?: { line: number; column?: number }
} {
  const match = /^(.+?):([1-9]\d*)(?::([1-9]\d*))?$/.exec(query.trim())
  if (!match) return { path: query }
  const line = Number(match[2])
  const column = match[3] ? Number(match[3]) : undefined
  if (!Number.isSafeInteger(line) || (column !== undefined && !Number.isSafeInteger(column)))
    return { path: query }
  return { path: match[1]!, target: { line, ...(column !== undefined ? { column } : {}) } }
}
