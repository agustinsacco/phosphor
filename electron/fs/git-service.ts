import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './git-exec'

/** Per-file porcelain status for explorer dots: relativePath → XY code. */
export async function gitStatusMap(workspacePath: string): Promise<Record<string, string>> {
  const out = await git(workspacePath, ['status', '--porcelain', '-uall'], { allowFail: true })
  const map: Record<string, string> = {}
  for (const line of out.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    let path = line.slice(3)
    // Renames: "R  old -> new"
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
    map[path] = code
  }
  return map
}

/**
 * Session baseline: a commit-ish capturing the exact worktree at session
 * start WITHOUT touching the working directory, the index, or HEAD.
 * Returns null for non-repos.
 *
 * This used to be `git stash create`, which **silently omits untracked
 * files**. Untracked files are exactly the class that was unrecoverable when
 * two concurrent sessions collided in one tree (docs/specs/TRACKER.md:114 — one agent ran
 * `git add -A && commit` and discarded the rest; a component and an extracted
 * module were rebuilt from scratch). So the product's own undo did not cover
 * the loss it was written for.
 *
 * The replacement stages into a throwaway index and writes a real tree:
 *
 *   read-tree HEAD → add -A → write-tree → commit-tree
 *
 * Two things are load-bearing.
 *
 * 1. `GIT_INDEX_FILE` must live OUTSIDE the worktree. Point it inside and
 *    `git add -A` captures the index file into the tree it is indexing.
 * 2. The identity is forced in the env. `commit-tree` fails outright on a
 *    machine with no `user.email` configured, and a baseline that only works
 *    on configured machines is worse than none.
 *
 * `add -A` honours `.gitignore`, so `node_modules` and build output stay out;
 * this captures untracked *source*, which is the point.
 *
 * Lifetime is unchanged from the stash version: the commit is a loose object
 * nothing references, so it survives until a `git gc` prune (default two
 * weeks), which comfortably outlives a session.
 */
export async function createSessionBaseline(workspacePath: string): Promise<string | null> {
  try {
    await git(workspacePath, ['rev-parse', '--git-dir'])
  } catch {
    return null
  }

  const head = await git(workspacePath, ['rev-parse', 'HEAD'], { allowFail: true, trim: true })
  const indexFile = join(tmpdir(), `phosphor-baseline-${randomUUID()}.index`)
  const env = {
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: 'Phosphor',
    GIT_AUTHOR_EMAIL: 'phosphor@localhost',
    GIT_COMMITTER_NAME: 'Phosphor',
    GIT_COMMITTER_EMAIL: 'phosphor@localhost',
  }

  try {
    // Skipped in a repo with no commits yet: there is no tree to read.
    if (head) await git(workspacePath, ['read-tree', head], { env })
    await git(workspacePath, ['add', '-A'], { env })
    const tree = await git(workspacePath, ['write-tree'], { env, trim: true })
    if (!tree) return head || null
    const args = ['commit-tree', tree, '-m', 'Phosphor session baseline']
    if (head) args.push('-p', head)
    const commit = await git(workspacePath, args, { env, trim: true })
    return commit || head || null
  } catch {
    // Any failure falls back to HEAD, which is what the old code did when the
    // tree was clean. Never throw: a missing baseline degrades the diff pane,
    // it must not fail session start.
    return head || null
  } finally {
    await rm(indexFile, { force: true })
  }
}

/** Content of a file at the baseline; null when it didn't exist yet. */
export async function showFileAt(
  workspacePath: string,
  ref: string,
  relativePath: string,
): Promise<string | null> {
  try {
    // Not `allowFail`: '' is a legitimate file content, and `restoreFileTo`
    // treats null as "did not exist at baseline" and trashes the file.
    return await git(workspacePath, ['show', `${ref}:${relativePath}`])
  } catch {
    return null
  }
}

/** Restore one file to its baseline content (file-recovery UX). */
export async function restoreFileTo(
  workspacePath: string,
  ref: string,
  relativePath: string,
): Promise<{ restored: boolean; deleted: boolean }> {
  const baselineContent = await showFileAt(workspacePath, ref, relativePath)
  if (baselineContent === null) {
    // Didn't exist at baseline — the session created it; trash it.
    const { join } = await import('node:path')
    await shell.trashItem(join(workspacePath, relativePath))
    return { restored: false, deleted: true }
  }
  await git(workspacePath, ['checkout', ref, '--', relativePath])
  return { restored: true, deleted: false }
}
