import { randomUUID } from 'node:crypto'
import { lstat, mkdir, opendir, realpath, rename, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { git } from '@phosphor/session-runtime/git/git-exec'
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
export async function branchMerged(root: string, branch: string): Promise<boolean> {
  if (!isLaneBranchName(branch)) return false
  const run = (args: string[]) => git(root, args, { isolateEnv: true, trim: true })
  // The trunk lane creation used. No trunk means no proof, never a proof against HEAD.
  const trunk = await resolveDefaultBranch(run).catch(() => null)
  if (trunk === null || branch === trunk) return false
  for (const base of defaultBranchRefs(trunk)) {
    try {
      await run(['merge-base', '--is-ancestor', `refs/heads/${branch}`, base])
      return true
    } catch {
      /* Try squash proof. */
    }
    try {
      const mergeBase = await run(['merge-base', base, `refs/heads/${branch}`])
      const tree = await run(['rev-parse', `refs/heads/${branch}^{tree}`])
      const probe = await git(
        root,
        ['commit-tree', tree, '-p', mergeBase, '-m', 'Phosphor squash-merge probe'],
        {
          isolateEnv: true,
          trim: true,
          env: {
            GIT_AUTHOR_NAME: 'Phosphor',
            GIT_AUTHOR_EMAIL: 'phosphor@localhost',
            GIT_COMMITTER_NAME: 'Phosphor',
            GIT_COMMITTER_EMAIL: 'phosphor@localhost',
          },
        },
      )
      if ((await run(['cherry', base, probe])).startsWith('-')) return true
    } catch {
      /* No proof means no deletion. */
    }
  }
  return false
}
export function createLaneDeletion(options: {
  store: HostStore
  stop(laneId: string, allowed: () => boolean): Promise<void>
  remove(request: unknown): Promise<void>
  forget(laneId: string): void
}) {
  return async (
    op: DeleteLaneOp,
    allowed: () => boolean,
  ): Promise<{ ok: true; data: { branchKept: boolean } } | { ok: false; code: RejectCode }> => {
    const lane = options.store.getLane(op.laneId)
    const repo = lane && options.store.listRepositories().find((r) => r.id === lane.repositoryId)
    if (!lane || lane.removedAt !== null || !repo) return { ok: false, code: 'unknown-lane' }
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
        branchKept = !(await deleteMergedBranch(root, lane.branch, allowed))
      if (!allowed()) return { ok: false, code: 'forbidden' }
      options.store.markRemoved(lane.laneId)
      options.forget(lane.laneId)
      return { ok: true, data: { branchKept } }
    } catch {
      return { ok: false, code: allowed() ? 'bad-request' : 'forbidden' }
    }
  }
}

/** Kept branches are not lane deletion failures. Checkout is re-checked around the deletion. */
export async function deleteMergedBranch(
  root: string,
  branch: string,
  allowed: () => boolean = () => true,
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
    if (current === `refs/heads/${branch}`) return false
    const worktrees = await run(['worktree', 'list', '--porcelain'])
    if (worktrees.split('\n').includes(`branch refs/heads/${branch}`)) return false
    const tip = await run(['rev-parse', '--verify', `refs/heads/${branch}`])
    if (!allowed() || !(await branchMerged(root, branch))) return false
    if (tip !== (await run(['rev-parse', '--verify', `refs/heads/${branch}`]))) return false
    // Every merged branch (ancestry or squash) is removed by one compare-and-delete at the
    // proven tip. `git branch -d` would delete whatever tip is current, not the proven one.
    const before = await run(['worktree', 'list', '--porcelain'])
    if (before.split('\n').includes(`branch ${ref}`) || !allowed()) return false
    // Never dereference a symbolic ref or lose a concurrently advanced tip.
    await run(['update-ref', '--no-deref', '-d', ref, tip])
    const after = await run(['worktree', 'list', '--porcelain'])
    if (after.split('\n').includes(`branch ${ref}`)) {
      // A checkout raced the mutation. Restore only if no writer recreated the ref.
      await run(['update-ref', ref, tip, ''])
      return false
    }
    return true
  } catch {
    return false
  }
}
