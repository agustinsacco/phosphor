import { isUuid } from './control-api'

export const FILE_LIMITS = { entries: 20_000, textBytes: 2 * 1024 * 1024, pathChars: 4096 } as const
export const FILE_METHODS = [
  'files.list',
  'files.read',
  'git.status',
  'git.diff',
  'git.show',
] as const
export type FileMethod = (typeof FILE_METHODS)[number]
export interface FileParams {
  laneId: string
  path?: string
  staged?: boolean
  ref?: string
}
export type FileRead =
  | { binary: true; size: number }
  | { binary: false; size: number; content: string; revision?: string | null }
export interface FileList {
  files: string[]
}
export interface FileDiff {
  diff: string
}
export type FileResult = FileList | FileDiff | FileRead | GitStatus
export interface GitStatus {
  status: Record<string, string>
  branch: string | null
  ahead: number
  behind: number
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
export function isRevision(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
}
export function isFilePath(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= FILE_LIMITS.pathChars &&
    !v.includes('\\') &&
    !v.includes('\0') &&
    !/^[A-Za-z]:/.test(v) &&
    v.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git')
  )
}
export function parseFileParams(method: string, v: unknown): FileParams | null {
  if (!record(v) || !isUuid(v.laneId)) return null
  const keys =
    method === 'git.diff'
      ? ['laneId', 'path', 'staged']
      : method === 'git.show'
        ? ['laneId', 'path', 'ref']
        : method === 'files.read'
          ? ['laneId', 'path']
          : ['laneId']
  if (!FILE_METHODS.some((m) => m === method) || Object.keys(v).some((k) => !keys.includes(k)))
    return null
  if (
    (method === 'files.read' || method === 'git.show' || v.path !== undefined) &&
    !isFilePath(v.path)
  )
    return null
  if (v.staged !== undefined && typeof v.staged !== 'boolean') return null
  if (
    method === 'git.show' &&
    (typeof v.ref !== 'string' || !/^(HEAD|[a-fA-F0-9]{4,40})$/.test(v.ref))
  )
    return null
  return {
    laneId: v.laneId,
    ...(typeof v.path === 'string' ? { path: v.path } : {}),
    ...(typeof v.staged === 'boolean' ? { staged: v.staged } : {}),
    ...(typeof v.ref === 'string' ? { ref: v.ref } : {}),
  }
}
const size = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
// Pure UTF-8 size calculation, without Node or DOM dependencies.
function textSize(v: string): number {
  let bytes = 0
  for (const c of v) {
    const n = c.codePointAt(0) ?? 0
    bytes += n <= 127 ? 1 : n <= 2047 ? 2 : n <= 65535 ? 3 : 4
  }
  return bytes
}
export function parseFileResult(method: string, v: unknown): FileResult | null {
  if (!record(v)) return null
  if (method === 'files.list')
    return Array.isArray(v.files) &&
      v.files.length <= FILE_LIMITS.entries &&
      v.files.every(isFilePath)
      ? { files: v.files }
      : null
  if (method === 'git.diff')
    return typeof v.diff === 'string' && textSize(v.diff) <= FILE_LIMITS.textBytes
      ? { diff: v.diff }
      : null
  if (method === 'files.read' || method === 'git.show') {
    if (!size(v.size)) return null
    if (v.binary === true && v.content === undefined) return { binary: true, size: v.size }
    if (
      v.binary === false &&
      typeof v.content === 'string' &&
      v.size <= FILE_LIMITS.textBytes &&
      textSize(v.content) <= FILE_LIMITS.textBytes
    )
      return method === 'files.read'
        ? isRevision(v.revision)
          ? { binary: false, size: v.size, content: v.content, revision: v.revision }
          : null
        : { binary: false, size: v.size, content: v.content }
  }
  if (
    method === 'git.status' &&
    record(v.status) &&
    Object.keys(v.status).length <= FILE_LIMITS.entries &&
    Object.entries(v.status).every(
      ([p, s]) => isFilePath(p) && typeof s === 'string' && /^[ MADRCU?!T]{2}$/.test(s),
    ) &&
    (v.branch === null || (typeof v.branch === 'string' && v.branch.length <= 200)) &&
    size(v.ahead) &&
    size(v.behind)
  ) {
    const status: Record<string, string> = {}
    for (const [p, s] of Object.entries(v.status)) {
      if (typeof s !== 'string') return null
      Object.defineProperty(status, p, { value: s, enumerable: true })
    }
    return { status, branch: v.branch, ahead: v.ahead, behind: v.behind }
  }
  return null
}
