import type { GhRunner } from './github'

/**
 * The proofs Phosphor accepts that a lane branch's work is already on the
 * trunk, and the one way it deletes a branch that is not merged by ancestry.
 * This Mac's worktree removal and the Host's lane deletion both use them.
 *
 * Every proof is about one commit: the tip the caller read. The deletion then
 * removes the ref only while it still points at that tip, so a branch that
 * gained a commit during the proof survives.
 */

/** Runs git in the repository: trimmed stdout, rejecting on a non-zero exit. */
export type BranchGit = (args: string[]) => Promise<string>

/** The branch's commit, or '' when it does not exist. */
export const branchTip = (run: BranchGit, branch: string): Promise<string> =>
  run(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]).catch(() => '')

/** What GitHub says about a branch's merged pull requests. Null means no answer. */
export interface PullRequestEvidence {
  mergedPrHeads(branch: string): Promise<string[] | null>
  commitTree(oid: string): Promise<string | null>
}

/**
 * Is `tip` on one of `bases`, by ancestry or as a squash merge?
 *
 * `git branch -d` only asks "is it an ancestor", and a squash merge rewrites
 * the branch into one new commit that has no ancestry link back to it. The
 * squash test is the standard one: synthesise a commit holding the tip's tree
 * on top of the merge base, then ask `git cherry` whether an equivalent patch
 * is already upstream. The synthesised commit is dangling, so gc collects it.
 * Errors mean "not landed", never proof.
 */
export async function landedOnTrunk(
  run: BranchGit,
  tip: string,
  bases: readonly string[],
): Promise<boolean> {
  for (const base of bases) {
    try {
      await run(['merge-base', '--is-ancestor', tip, base])
      return true
    } catch {
      // Not an ancestor. It can still have been squashed onto the trunk.
    }
    try {
      const mergeBase = await run(['merge-base', base, tip])
      const tree = await run(['rev-parse', `${tip}^{tree}`])
      if (!mergeBase || !tree) continue
      const probe = await run([
        'commit-tree',
        tree,
        '-p',
        mergeBase,
        '-m',
        'Phosphor squash-merge probe',
      ])
      // `git cherry` prefixes '-' when an equivalent patch is already upstream.
      if ((await run(['cherry', base, probe])).startsWith('-')) return true
    } catch {
      // Cannot prove it: try the next base, then answer false.
    }
  }
  return false
}

/**
 * Did `tip` land through a merged GitHub PR from `branch`?
 *
 * Git cannot see a lane whose history was rewritten after the merge, or whose
 * squash was cut on a trunk that had moved. A merged PR proves those, but only
 * when the tip IS the PR head, is an ancestor of it, or has the same tree. A
 * branch that reuses a merged PR's name, or gained commits after the merge,
 * fails all three. No answer from GitHub means not landed.
 */
export async function landedViaPullRequest(
  run: BranchGit,
  github: PullRequestEvidence,
  branch: string,
  tip: string,
): Promise<boolean> {
  const heads = await github.mergedPrHeads(branch)
  if (!heads?.length) return false
  const tree = await run(['rev-parse', `${tip}^{tree}`]).catch(() => '')
  if (!tree) return false
  for (const head of heads) {
    if (head === tip) return true
    if (await run(['cat-file', '-t', head]).catch(() => '')) {
      try {
        await run(['merge-base', '--is-ancestor', tip, head])
        return true
      } catch {
        // Not behind the PR head; the content can still be identical.
      }
      if ((await run(['rev-parse', `${head}^{tree}`]).catch(() => '')) === tree) return true
    } else if ((await github.commitTree(head)) === tree) {
      return true
    }
  }
  return false
}

/**
 * Delete `refs/heads/<branch>` only while it points at `tip` and no worktree
 * has it checked out. `git branch -D` would delete whatever tip is current.
 * A checkout that races the deletion gets the ref back. Resolves whether the
 * branch went; rejects when the ref moved.
 */
export async function deleteBranchAtTip(
  run: BranchGit,
  branch: string,
  tip: string,
  allowed: () => boolean = () => true,
): Promise<boolean> {
  const ref = `refs/heads/${branch}`
  const checkedOut = async (): Promise<boolean> =>
    (await run(['worktree', 'list', '--porcelain'])).split('\n').includes(`branch ${ref}`)
  if ((await checkedOut()) || !allowed()) return false
  // Never dereference a symbolic ref or lose a concurrently advanced tip.
  await run(['update-ref', '--no-deref', '-d', ref, tip])
  if (await checkedOut()) {
    // Restore only if no writer recreated the ref.
    await run(['update-ref', ref, tip, ''])
    return false
  }
  return true
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** Head commits of the branch's merged PRs: read-only evidence, never proof on its own. */
export async function ghMergedPrHeads(
  gh: GhRunner,
  repoPath: string,
  branch: string,
): Promise<string[] | null> {
  if (!branch) return null
  const raw = await gh(repoPath, [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'merged',
    '--limit',
    '20',
    '--json',
    'headRefOid',
  ])
  if (raw === null) return null
  try {
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows)) return null
    return rows
      .map((row: { headRefOid?: unknown }) => row?.headRefOid)
      .filter((oid): oid is string => typeof oid === 'string' && OID.test(oid))
  } catch {
    return null
  }
}

/** A commit never changes its tree, so one answer per commit is enough. */
const commitTrees = new Map<string, string>()
export async function ghCommitTree(
  gh: GhRunner,
  repoPath: string,
  oid: string,
): Promise<string | null> {
  if (!OID.test(oid)) return null
  const cached = commitTrees.get(oid)
  if (cached) return cached
  const raw = await gh(repoPath, [
    'api',
    `repos/{owner}/{repo}/git/commits/${oid}`,
    '--jq',
    '.tree.sha',
  ])
  const tree = raw?.trim() ?? ''
  if (!OID.test(tree)) return null
  commitTrees.set(oid, tree)
  return tree
}
