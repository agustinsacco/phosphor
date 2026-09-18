/**
 * Folder containment, as both processes have to agree on it.
 *
 * Lives in `shared/` because main and the renderer ask the same question of
 * the same folder during a sandbox rename: main refuses to move a folder with
 * a live pi anywhere inside it, and the renderer closes exactly those chats
 * first. Two copies of a containment rule drift, and this one fails silently —
 * a lane that one side calls "inside" and the other does not is a cwd renamed
 * out from under a running process.
 *
 * Pure string work, so one copy serves both: no `node:path`, and both
 * separators are accepted because a path reaches these functions as whatever
 * the platform wrote.
 */

/** Strip trailing separators, so `/a/b/` and `/a/b` are one folder. */
function withoutTrailingSeparator(folder: string): string {
  return folder.replace(/[/\\]+$/, '')
}

/**
 * Is `path` `folder` itself, or somewhere inside it?
 *
 * The separator guard is what stops `/a/box` from claiming `/a/box-2`, the
 * same rule and the same reason as `repointPath` (`electron/prefs-utils.ts`).
 */
export function isWithinFolder(path: string, folder: string): boolean {
  const base = withoutTrailingSeparator(folder)
  if (path === base) return true
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)
}

/**
 * `path`, with the `from` prefix rewritten to `to`.
 *
 * Only meaningful for a path `isWithinFolder` already accepted — the caller
 * has established containment, so this is the arithmetic, not a second test.
 * A path equal to `from` maps to `to` itself, which is what makes a moved
 * folder and the lanes inside it one list rather than two cases.
 */
export function rebaseWithinFolder(path: string, from: string, to: string): string {
  const base = withoutTrailingSeparator(from)
  if (!isWithinFolder(path, base)) return path
  return withoutTrailingSeparator(to) + path.slice(base.length)
}
