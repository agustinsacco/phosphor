import { FILE_LIMITS, isFilePath, isRevision } from './host-protocol-files'

export type FileWriteOp =
  | { type: 'files.write'; path: string; content: string; expected: string | null }
  | { type: 'files.create'; path: string; kind: 'file' | 'directory' }
  | { type: 'files.rename'; from: string; to: string }
  | { type: 'files.delete'; path: string }
  | { type: 'files.transfer'; source: string; directory: string; mode: 'copy' | 'move' }

export function parseFileWriteOp(v: unknown): FileWriteOp | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const p: Record<string, unknown> = Object.fromEntries(Object.entries(v))
  const exact = (keys: string[]) =>
    Object.keys(p).length === keys.length && keys.every((k) => Object.hasOwn(p, k))
  switch (p.type) {
    case 'files.write':
      if (
        exact(['type', 'path', 'content', 'expected']) &&
        isFilePath(p.path) &&
        typeof p.content === 'string' &&
        isRevision(p.expected)
      ) {
        let bytes = 0
        for (const c of p.content) {
          const n = c.codePointAt(0) ?? 0
          bytes += n <= 127 ? 1 : n <= 2047 ? 2 : n <= 65535 ? 3 : 4
          if (bytes > FILE_LIMITS.textBytes) return null
        }
        return { type: p.type, path: p.path, content: p.content, expected: p.expected }
      }
      break
    case 'files.create':
      if (
        exact(['type', 'path', 'kind']) &&
        isFilePath(p.path) &&
        (p.kind === 'file' || p.kind === 'directory')
      )
        return { type: p.type, path: p.path, kind: p.kind }
      break
    case 'files.rename':
      if (exact(['type', 'from', 'to']) && isFilePath(p.from) && isFilePath(p.to))
        return { type: p.type, from: p.from, to: p.to }
      break
    case 'files.delete':
      if (exact(['type', 'path']) && isFilePath(p.path)) return { type: p.type, path: p.path }
      break
    case 'files.transfer':
      if (
        exact(['type', 'source', 'directory', 'mode']) &&
        isFilePath(p.source) &&
        (p.directory === '.' || isFilePath(p.directory)) &&
        (p.mode === 'copy' || p.mode === 'move')
      )
        return { type: p.type, source: p.source, directory: p.directory, mode: p.mode }
  }
  return null
}

export function parseWriteResult(
  v: unknown,
): { revision: string; mtimeMs: number } | { path: string } | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  if (
    'revision' in v &&
    typeof v.revision === 'string' &&
    isRevision(v.revision) &&
    'mtimeMs' in v &&
    typeof v.mtimeMs === 'number' &&
    Number.isFinite(v.mtimeMs) &&
    v.mtimeMs >= 0 &&
    Object.keys(v).length === 2
  )
    return { revision: v.revision, mtimeMs: v.mtimeMs }
  if ('path' in v && isFilePath(v.path) && Object.keys(v).length === 1) return { path: v.path }
  return null
}
