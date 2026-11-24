import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { contextFileKind, type ContextBlock } from './context-files'
import { contains, isMainCheckoutPath, type WorktreeInfo } from './main-checkout'

export interface ContextFile {
  path: string
  content: string
}

/** pi strips a leading BOM before wrapping each file. */
export function renderContextBlock(file: ContextFile): string {
  return `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`
}

/** Only stat on a cache hit. Repo refresh never follows a replacement symlink or blocks on a FIFO. */
export function contextReader(global: boolean) {
  const cache = new Map<string, { size: number; mtimeMs: number; file: ContextFile }>()
  return (path: string): ContextFile | null | undefined => {
    try {
      const stat = (global ? statSync : lstatSync)(path)
      if (stat.isSymbolicLink()) return undefined // keep pi's snapshot; do not follow a retargeted repo link
      if (!stat.isFile()) return null
      const hit = cache.get(path)
      if (hit?.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.file
      const fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK | (global ? 0 : constants.O_NOFOLLOW),
      )
      try {
        const opened = fstatSync(fd)
        if (!opened.isFile()) return null
        const file = { path, content: readFileSync(fd, 'utf8').replace(/^\uFEFF/, '') }
        cache.set(path, { size: opened.size, mtimeMs: opened.mtimeMs, file })
        return file
      } finally {
        closeSync(fd)
      }
    } catch {
      cache.delete(path)
      return null
    }
  }
}

/** Only refresh instruction files pi rendered, never discover new ones or trust arbitrary tag paths. */
export function repoContextReader() {
  const read = contextReader(false)
  return (block: ContextBlock, cwd?: string, worktree?: WorktreeInfo | null) => {
    const { path, text } = block
    if (
      !cwd ||
      !contextFileKind(path) ||
      resolve(path) !== path ||
      !contains(dirname(path), cwd) ||
      isMainCheckoutPath(path, worktree)
    )
      return text
    const file = read(path)
    return file === undefined ? text : file && renderContextBlock(file)
  }
}
