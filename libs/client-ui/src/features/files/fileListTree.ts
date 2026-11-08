import type { DirEntry } from '@shared/models'

/** Deeper or larger lists are refused rather than drawn as a partial tree. */
const MAX_DEPTH = 64
const MAX_ENTRIES = 50_000

/**
 * A flat list of relative file paths as directory listings: each folder's entries under its path
 * (`root` itself for the top), folders first, then by name, as `fs:readDir` orders them. Null when
 * the list passes the depth or size cap. Entry paths are `root`-prefixed, or relative when `root`
 * is empty.
 */
export function foldFileList(root: string, files: string[]): Record<string, DirEntry[]> | null {
  const kinds = new Map<string, boolean>()
  for (const file of files) {
    const parts = file.split('/')
    if (parts.length > MAX_DEPTH) return null
    for (let i = 0; i < parts.length; i++) {
      if (kinds.size >= MAX_ENTRIES) return null
      kinds.set(parts.slice(0, i + 1).join('/'), i < parts.length - 1)
    }
  }
  const join = (relative: string) => (root && relative ? `${root}/${relative}` : root || relative)
  const listings: Record<string, DirEntry[]> = { [root]: [] }
  for (const [relativePath, isDirectory] of kinds) {
    const slash = relativePath.lastIndexOf('/')
    const parent = join(slash < 0 ? '' : relativePath.slice(0, slash))
    if (isDirectory) listings[join(relativePath)] ??= []
    ;(listings[parent] ??= []).push({
      name: relativePath.slice(slash + 1),
      path: join(relativePath),
      relativePath,
      isDirectory,
    })
  }
  for (const entries of Object.values(listings))
    entries.sort((a, b) =>
      a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name),
    )
  return listings
}
