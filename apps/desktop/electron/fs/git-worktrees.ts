import {
  normalizeRealPath,
  listWorktreeMetadata,
} from '@phosphor/session-runtime/git/worktree-metadata'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AddWorktreeBranch, WorktreeInfo } from '@shared/models'
import { dirtyCount, git, gitErrorText } from '@phosphor/session-runtime/git/git-exec'
import { gitInfoCache } from '@phosphor/session-runtime/git/git-info-cache'
import {
  branchTip,
  deleteBranchAtTip,
  landedOnTrunk,
  landedViaPullRequest as landedViaPullRequestAt,
  type BranchGit,
} from '@phosphor/session-runtime/git/branch-landed'
import { ghEvidence } from './gh-cli'
import { mapLimit } from '@phosphor/session-runtime/map-limit'
import {
  addGitWorktree,
  removeGitWorktree,
  worktreeRootFor,
} from '@phosphor/session-runtime/git/managed-worktree'
export { worktreeRootFor } from '@phosphor/session-runtime/git/managed-worktree'
import { ensureExcluded } from './worktree-exclude'
import { listBranches, refExists, startPoint } from '@phosphor/session-runtime/git/branches'
export { listBranches, startPoint } from '@phosphor/session-runtime/git/branches'
export {
  commitAll,
  mergeBranch,
  renameBranch,
} from '@phosphor/session-runtime/git/checkout-mutations'

const execFileAsync = promisify(execFile)

/**
 * Worktree lifecycle for Phosphor sessions.
 *
 * Layout decision: worktrees live INSIDE the repo at
 * `<repo>/.phosphor/worktrees/<name>` (mirroring the `.claude/worktrees`
 * convention), ignored via `.git/info/exclude` so `git status` stays clean
 * without touching tracked files. In-repo keeps them discoverable from a
 * plain file listing, and its `git:info` (`isWorktree` / `mainRepoPath`) is
 * what lets the sidebar fold a worktree's sessions back into its main repo's
 * group instead of giving each worktree its own top-level entry.
 *
 * Two standing rules:
 * - The main tree's checkout is NEVER changed on the user's behalf.
 * - Nothing uncommitted is deleted without an explicit force.
 */

/** Both dir name and branch name — reject anything path- or ref-hostile. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  return mapLimit(await listWorktreeMetadata(repoPath), 4, async (wt) => ({
    ...wt,
    dirtyCount: existsSync(wt.path) ? await dirtyCount(wt.path).catch(() => -1) : -1,
  }))
}

export async function addWorktree(
  repoPath: string,
  name: string,
  branch: AddWorktreeBranch,
): Promise<WorktreeInfo> {
  const path = await createWorktree(repoPath, name, branch)
  const worktrees = await listWorktreeMetadata(repoPath)
  const created = worktrees.find((w) => w.path === path || w.realPath === normalizeRealPath(path))
  if (!created) throw new Error('Worktree was created but not found in `git worktree list`.')
  return { ...created, dirtyCount: await dirtyCount(created.path).catch(() => -1) }
}

/** Validate and `git worktree add`, returning the new folder; nothing is listed after. */
export async function createWorktree(
  repoPath: string,
  name: string,
  branch: AddWorktreeBranch,
): Promise<string> {
  if (!NAME_PATTERN.test(name) || name.includes('..')) {
    throw new Error(`Invalid worktree name "${name}" — letters, digits, ./_- only.`)
  }
  if (branch.kind === 'new' && branch.branch !== undefined) {
    if (!NAME_PATTERN.test(branch.branch) || branch.branch.includes('..')) {
      throw new Error(`Invalid branch name "${branch.branch}" — letters, digits, ./_- only.`)
    }
  }
  const path = join(worktreeRootFor(repoPath), name)
  if (existsSync(path)) {
    throw new Error(`Worktree folder already exists: ${path}`)
  }

  if (branch.kind === 'existing') {
    const [worktrees, { defaultBranch }] = await Promise.all([
      listWorktreeMetadata(repoPath),
      listBranches(repoPath),
    ])
    const taken = worktrees.find((w) => w.branch === branch.branch)
    if (taken) {
      throw new Error(
        `Branch "${branch.branch}" is already checked out in ${taken.isMain ? 'the main tree' : taken.path}.`,
      )
    }
    // Trunk belongs to the main working tree. git only refuses this while the
    // branch is *currently* checked out, so from a feature branch it would
    // happily move trunk into a worktree — and then the main tree can never
    // check it out again ("fatal: 'main' is already used by worktree at …").
    // A worktree is for parallel work beside trunk, never instead of it.
    if (branch.branch === defaultBranch) {
      throw new Error(
        `"${branch.branch}" is this repo's default branch — it belongs in the main working tree. ` +
          `Putting it in a worktree would stop the main tree from ever checking it out. ` +
          `Open the main tree to work on ${branch.branch}, or branch off it instead.`,
      )
    }
  }

  await mkdir(worktreeRootFor(repoPath), { recursive: true })
  await ensureExcluded(repoPath)

  await addGitWorktree(
    repoPath,
    path,
    branch.kind === 'new' ? { ...branch, branch: branch.branch ?? name } : branch,
  )
  return path
}

const proofGit =
  (repoPath: string): BranchGit =>
  (args) =>
    git(repoPath, args, { trim: true })

/**
 * Is this branch's work already on the trunk, squash merges included?
 *
 * Phosphor lanes land as squash-merged PRs, which `git branch -d` refuses.
 * `landedOnTrunk` also accepts the squash. Both remote and local trunk are
 * checked. `tip` pins the proof to the commit a deletion will compare against.
 */
export async function isBranchMerged(
  repoPath: string,
  branch: string,
  tip = branch,
): Promise<boolean> {
  const { defaultBranch } = await startPoint(repoPath)
  if (branch === defaultBranch) return false
  const bases: string[] = []
  for (const ref of [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`]) {
    if (await refExists(repoPath, ref)) bases.push(ref)
  }
  return landedOnTrunk(proofGit(repoPath), tip, bases)
}

/**
 * Did this branch land through a merged GitHub PR?
 *
 * `isBranchMerged` can only see what git can. On one real install it proved
 * 2 of 26 merged lanes, so the sweep reported "0 reclaimable" over tens of
 * gigabytes. gh being absent or offline answers false.
 */
export async function landedViaPullRequest(
  repoPath: string,
  branch: string,
  tip?: string,
): Promise<boolean> {
  const commit = tip ?? (await branchTip(proofGit(repoPath), branch))
  if (!commit) return false
  return landedViaPullRequestAt(proofGit(repoPath), ghEvidence(repoPath), branch, commit)
}

/** Every proof Phosphor accepts that a branch's commit `tip` is already on the trunk. */
async function isBranchLanded(repoPath: string, branch: string, tip: string): Promise<boolean> {
  return (
    (await isBranchMerged(repoPath, branch, tip)) ||
    (await landedViaPullRequest(repoPath, branch, tip))
  )
}

/**
 * `git branch -d` when git sees the merge. Otherwise prove the current tip
 * landed and delete exactly that tip: unmerged branches, and a branch that
 * moved during the proof, survive checkout removal.
 */
async function deleteLandedBranch(
  repoPath: string,
  branch: string,
): Promise<{ branchDeleted: boolean; branchError?: string }> {
  try {
    await git(repoPath, ['branch', '-d', branch])
    return { branchDeleted: true }
  } catch (error) {
    const run = proofGit(repoPath)
    const kept = { branchDeleted: false, branchError: gitErrorText(error) }
    const tip = await branchTip(run, branch)
    if (!tip || !(await isBranchLanded(repoPath, branch, tip))) return kept
    try {
      return (await deleteBranchAtTip(run, branch, tip)) ? { branchDeleted: true } : kept
    } catch (deleteError) {
      // The compare-and-delete refused because the branch is no longer the proven tip.
      const moved = (await branchTip(run, branch)) !== tip
      return {
        branchDeleted: false,
        branchError: moved
          ? 'it changed while Phosphor checked that it had landed.'
          : gitErrorText(deleteError),
      }
    }
  }
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  options: { force?: boolean; deleteBranch?: boolean } = {},
  beforeRemove?: (target: WorktreeInfo) => void,
): Promise<
  | { removed: true; branchDeleted: boolean; branchError?: string }
  | { removed: false; dirtyCount: number }
> {
  const worktrees = await listWorktrees(repoPath)
  const target = worktrees.find(
    (w) => w.path === worktreePath || w.realPath === normalizeRealPath(worktreePath),
  )
  if (!target) throw new Error(`Not a linked worktree of this repo: ${worktreePath}`)
  if (target.isMain) throw new Error('Refusing to remove the main working tree.')
  if (target.locked) throw new Error('Refusing to remove a locked worktree.')
  if (target.dirtyCount < 0) throw new Error('Cannot verify worktree status.')

  if (!options.force && target.dirtyCount > 0) {
    return { removed: false, dirtyCount: target.dirtyCount }
  }

  beforeRemove?.(target) // Synchronous: no await between the final guard and dispatch.
  await removeGitWorktree(repoPath, target.path, options.force === true)

  if (!options.deleteBranch || !target.branch) return { removed: true, branchDeleted: false }
  return { removed: true, ...(await deleteLandedBranch(repoPath, target.branch)) }
}

export async function pruneWorktrees(repoPath: string): Promise<{ pruned: string[] }> {
  // --verbose reports removals on stderr.
  gitInfoCache.invalidate()
  const { stdout, stderr } = await execFileAsync('git', ['worktree', 'prune', '--verbose'], {
    cwd: repoPath,
    timeout: 30_000,
  }).finally(() => gitInfoCache.invalidate())
  const pruned = `${stdout}\n${stderr}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return { pruned }
}
