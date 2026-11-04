import { randomUUID } from 'node:crypto'
import { lstat, mkdir, opendir, realpath, rename, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { git } from '@phosphor/session-runtime/git/git-exec'
import type { GhRunner } from '@phosphor/session-runtime/git/github'
import {
  deleteBranchAtTip,
  ghCommitTree,
  ghMergedPrHeads,
  landedOnTrunk,
  landedViaPullRequest,
  type BranchGit,
  type PullRequestEvidence,
} from '@phosphor/session-runtime/git/branch-landed'
import type { DeleteLaneOp } from '@phosphor/shared/host-protocol-repositories'
import { isLaneBranchName, type RejectCode } from '@phosphor/shared/host-protocol'
import type { HostStore } from './store'
import { inside } from '../features/files'
import { canonicalRemovedPath } from '../machine/repositories'
import { defaultBranchRefs, resolveDefaultBranch } from './default-branch'

const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'
const DAY = 86400_000
export function transcriptTrash(state: string) {
  const root = join(state, 'trash')
  async function directory() {
    await mkdir(root, { mode: 0o700 }).catch((error) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    })
    const info = await lstat(root)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(root)) !== join(await realpath(state), 'trash')
    )
      throw new Error('trash unavailable')
  }
  return {
    async move(file: string) {
      await directory()
      await rename(file, join(root, `${Date.now()}-${randomUUID()}.jsonl`))
    },
    async sweep(now = Date.now()) {
      await directory()
      let count = 0
      for await (const entry of await opendir(root)) {
        if (++count > 20000) break
        const match = /^(\d{13})-[a-f0-9-]{36}\.jsonl$/.exec(entry.name)
        if (entry.isFile() && match?.[1] && Number(match[1]) < now - 30 * DAY)
          await rm(join(root, entry.name))
      }
    },
  }
}
/** Proof commands run without the user's git config; the squash probe needs an identity. */
const proofGit =
  (root: string): BranchGit =>
  (args) =>
    git(root, args, {
      isolateEnv: true,
      trim: true,
      env: {
        GIT_AUTHOR_NAME: 'Phosphor',
        GIT_AUTHOR_EMAIL: 'phosphor@localhost',
        GIT_COMMITTER_NAME: 'Phosphor',
        GIT_COMMITTER_EMAIL: 'phosphor@localhost',
      },
    })

/** One PR proof starts no GitHub question after this long; a question already asked can finish. */
const PULL_REQUEST_PROOF_MS = 20_000

function pullRequestEvidence(root: string, github: GhRunner): PullRequestEvidence {
  const deadline = Date.now() + PULL_REQUEST_PROOF_MS
  const bounded: GhRunner = (cwd, args) =>
    Date.now() < deadline ? github(cwd, args) : Promise.resolve(null)
  return {
    mergedPrHeads: (branch) => ghMergedPrHeads(bounded, root, branch),
    commitTree: (oid) => ghCommitTree(bounded, root, oid),
  }
}

/**
 * Is the lane branch's tip on the trunk lane creation used: by ancestry, as a
 * squash, or through a merged GitHub PR when `github` can ask? `tip` pins the
 * proof to the commit the deletion compares against.
 */
export async function branchMerged(
  root: string,
  branch: string,
  { tip, github }: { tip?: string; github?: GhRunner } = {},
): Promise<boolean> {
  if (!isLaneBranchName(branch)) return false
  const run = proofGit(root)
  // The trunk lane creation used. No trunk means no proof, never a proof against HEAD.
  const trunk = await resolveDefaultBranch(run).catch(() => null)
  if (trunk === null || branch === trunk) return false
  const commit =
    tip ?? (await run(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]).catch(() => ''))
  if (!commit) return false
  if (await landedOnTrunk(run, commit, defaultBranchRefs(trunk))) return true
  return github
    ? landedViaPullRequest(run, pullRequestEvidence(root, github), branch, commit)
    : false
}
export function createLaneDeletion(options: {
  store: HostStore
  stop(laneId: string, allowed: () => boolean): Promise<void>
  remove(request: unknown): Promise<void>
  forget(laneId: string): void
  /** The Host's read-only gh, for the merged-PR proof. Without it only git proves a merge. */
  github?: GhRunner
}) {
  return async (
    op: DeleteLaneOp,
    allowed: () => boolean,
  ): Promise<{ ok: true; data: { branchKept: boolean } } | { ok: false; code: RejectCode }> => {
    const lane = options.store.getLane(op.laneId)
    if (!lane || lane.removedAt !== null) return { ok: false, code: 'unknown-lane' }
    const repo = options.store.listRepositories().find((r) => r.id === lane.repositoryId)
    if (!repo) return forgetUnlisted(options, lane.laneId, op, allowed)
    if (!allowed()) return { ok: false, code: 'forbidden' }
    const shared = () =>
      options.store.listLanes().some((l) => l.laneId !== lane.laneId && l.cwd === lane.cwd)
    if ((op.removeWorktree || op.removeBranch) && (!lane.worktree || shared()))
      return { ok: false, code: 'busy' }
    try {
      const root = await realpath(repo.path)
      const cwd = await realpath(lane.cwd).catch((error) => {
        if (!missing(error) || !lane.worktree) throw error
        return canonicalRemovedPath(lane.cwd)
      })
      if (
        !inside(root, cwd) ||
        (lane.worktree && (!inside(join(root, '.phosphor', 'worktrees'), cwd) || cwd === root))
      )
        return { ok: false, code: 'bad-request' }
      await options.stop(lane.laneId, allowed)
      if (!allowed()) return { ok: false, code: 'forbidden' }
      const file = options.store.getLane(lane.laneId)?.sessionFile
      // A previous attempt may have trashed the transcript before worktree removal failed.
      if (
        file &&
        (await lstat(file).then(
          () => true,
          (error) => {
            if (missing(error)) return false
            throw error
          },
        ))
      )
        await options.remove({ repository: lane.cwd, sessionPath: file })
      if (!allowed()) return { ok: false, code: 'forbidden' }
      if (
        op.removeWorktree &&
        (await lstat(cwd).then(
          () => true,
          (error) => {
            if (missing(error)) return false
            throw error
          },
        ))
      ) {
        if (
          shared() ||
          (await realpath(lane.cwd)) !== cwd ||
          dirname(await realpath(join(root, '.phosphor', 'worktrees'))) !== join(root, '.phosphor')
        )
          return { ok: false, code: 'busy' }
        if (!allowed()) return { ok: false, code: 'forbidden' }
        if (shared()) return { ok: false, code: 'busy' }
        await git(root, ['worktree', 'remove', '--', cwd], { isolateEnv: true })
      }
      let branchKept = op.removeBranch && lane.branch !== null
      if (op.removeBranch && lane.branch && !shared() && allowed())
        branchKept = !(await deleteMergedBranch(root, lane.branch, allowed, options.github))
      if (!allowed()) return { ok: false, code: 'forbidden' }
      options.store.markRemoved(lane.laneId)
      options.forget(lane.laneId)
      return { ok: true, data: { branchKept } }
    } catch {
      return { ok: false, code: allowed() ? 'bad-request' : 'forbidden' }
    }
  }
}

/**
 * A lane whose folder left the Host's config. With no folder to prove a
 * worktree, branch or transcript against, only the Host's record goes: the
 * files stay, and a transcript returns as a lane if the folder is added back.
 */
async function forgetUnlisted(
  options: Parameters<typeof createLaneDeletion>[0],
  laneId: string,
  op: DeleteLaneOp,
  allowed: () => boolean,
): Promise<{ ok: true; data: { branchKept: boolean } } | { ok: false; code: RejectCode }> {
  if (op.removeWorktree || op.removeBranch) return { ok: false, code: 'bad-request' }
  if (!allowed()) return { ok: false, code: 'forbidden' }
  try {
    await options.stop(laneId, allowed)
  } catch {
    return { ok: false, code: allowed() ? 'bad-request' : 'forbidden' }
  }
  if (!allowed()) return { ok: false, code: 'forbidden' }
  options.store.markRemoved(laneId)
  options.forget(laneId)
  return { ok: true, data: { branchKept: false } }
}

/** Kept branches are not lane deletion failures. Checkout is re-checked around the deletion. */
export async function deleteMergedBranch(
  root: string,
  branch: string,
  allowed: () => boolean = () => true,
  github?: GhRunner,
): Promise<boolean> {
  if (!isLaneBranchName(branch)) return false
  const run = (args: string[]) => git(root, args, { isolateEnv: true, trim: true })
  try {
    const ref = `refs/heads/${branch}`
    if (
      await run(['symbolic-ref', '-q', ref]).then(
        () => true,
        () => false,
      )
    )
      return false
    const current = await run(['symbolic-ref', '--quiet', 'HEAD'])
    if (current === ref) return false
    const worktrees = await run(['worktree', 'list', '--porcelain'])
    if (worktrees.split('\n').includes(`branch ${ref}`)) return false
    const tip = await run(['rev-parse', '--verify', ref])
    if (!allowed() || !(await branchMerged(root, branch, { tip, github }))) return false
    // Every proof (ancestry, squash or PR) ends in one compare-and-delete at the proven tip.
    return await deleteBranchAtTip(run, branch, tip, allowed)
  } catch {
    return false
  }
}
