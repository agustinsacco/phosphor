/**
 * Where a worktree session's main checkout is, and which paths belong to it.
 *
 * Phosphor puts a lane's worktree INSIDE the checkout it branched from
 * (`<repo>/.phosphor/worktrees/<name>`), so the main checkout is at once an
 * ancestor of the cwd and a different branch. Two extensions act on that fact:
 * `worktree-paths.ts` refuses tool calls that reach into it, and
 * `context-files.ts` drops the CLAUDE.md / AGENTS.md pi inherited from it.
 * They share one detector and one containment rule so they cannot disagree
 * about which tree a path is in.
 *
 * Imports resolve against pi's own runtime when it loads the extensions.
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve, sep } from 'node:path'

/** `parent` contains `child` (or is it). Both must be absolute. */
export function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * Main checkout for `cwd`, or null when `cwd` is not a linked worktree.
 *
 * Same one-call detection as the app's own `git-info.ts`: in a linked
 * worktree the git dir is `<main>/.git/worktrees/<name>` while the common dir
 * is `<main>/.git`; in an ordinary repo the two are equal.
 *
 * Synchronous because `worktree-paths.ts` runs it inside pi's `tool_call`
 * hook, so a hung git would stall the tool call; the timeout bounds it at one
 * second and a timeout counts as "not a worktree" for this cwd.
 */
export function detectMainRepo(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--absolute-git-dir', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    })
    const [gitDir, commonDirRaw] = out.split('\n').map((line) => line.trim())
    if (!gitDir || !commonDirRaw) return null
    // --git-common-dir comes back relative (".git") at a repo root.
    const commonDir = resolve(cwd, commonDirRaw)
    if (gitDir === commonDir) return null
    return dirname(commonDir)
  } catch {
    // Not a repo, no git on PATH, or git timed out: nothing to guard against.
    return null
  }
}

/** A session that runs in a linked worktree, and the checkout it branched from. */
export interface WorktreeInfo {
  cwd: string
  mainRepoPath: string
}

/**
 * Whether `path` belongs to the main checkout rather than the worktree: it
 * resolves inside `mainRepoPath` and outside `cwd`. Checked in that order on
 * purpose: the worktree is itself inside the main checkout, and its own files
 * must never count. A relative path resolves against the cwd, so it is never
 * the main checkout's. Nothing is the main checkout's when the session is not
 * a worktree.
 */
export function isMainCheckoutPath(
  path: string,
  worktree: WorktreeInfo | null | undefined,
): boolean {
  if (!worktree) return false
  const target = resolve(worktree.cwd, path)
  return !contains(worktree.cwd, target) && contains(worktree.mainRepoPath, target)
}
