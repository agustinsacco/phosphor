import { sep } from 'node:path'

/**
 * The Host's filesystem safety predicates. They classify values and compare
 * paths; none touches the disk, so each caller keeps its own type, symlink,
 * descriptor, size and inode checks around them.
 */

/** The errno code a thrown value carries: a string `code` on any object, Error or not. */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/**
 * Does `error` carry one of `codes`? Structural, like `errnoCode`: a caller
 * that accepts only Error instances keeps its own `instanceof Error` check.
 */
export function errnoIs(error: unknown, ...codes: readonly string[]): boolean {
  const code = errnoCode(error)
  return code !== undefined && codes.includes(code)
}

/**
 * Is `candidate` the root itself or inside it, by whole path segments?
 * Both must be canonical absolute paths, as realpath returns them. Nothing
 * is resolved or normalized here: `..`, `.` and trailing separators are
 * compared as written, so `/repo/../etc` counts as inside `/repo`.
 */
export function isInside(root: string, candidate: string): boolean {
  if (root === sep) return candidate.startsWith(sep)
  return candidate === root || candidate.startsWith(root + sep)
}

/** The ownership fields of an lstat or fstat result. */
export interface OwnedStat {
  readonly uid: number
  readonly mode: number
}

/**
 * Owned by `uid`, with no group or other permission bits. Owner bits are not
 * checked, so 0400 and 0700 pass as well as 0600. An unknown uid proves no
 * ownership and never passes.
 */
export function isOwnerPrivate(stat: OwnedStat, uid: number | undefined): boolean {
  return uid !== undefined && stat.uid === uid && (stat.mode & 0o077) === 0
}
