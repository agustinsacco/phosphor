import { parsePrUrl, PR_SUMMARY_BATCH_SIZE } from '@phosphor/shared/github-pr-refs'
import type { GhPrRef } from '@phosphor/shared/models'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { dataResult, fields, op, pageInventory } from '@phosphor/session-runtime/ops/results'
import type { OpHandler, OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import type { DaemonHandlerDeps } from './index'
import { listBranches } from '@phosphor/session-runtime/git/branches'
import { listWorktreeMetadata } from '@phosphor/session-runtime/git/worktree-metadata'
import { laneRoot } from '../../features/files'
import { gitMutationHandlers, gitRefusal, ownerGit } from './git-checkout'
import { worktreeHandlers } from './worktrees'
import { laneCall, requireRuntime, targetLane } from './lane-target'

function prRef(text: string): GhPrRef {
  const ref = parsePrUrl(text.trim())
  if (!ref) throw new OpRefusal('bad-request', `Name the pull request by its URL: ${text}`)
  return ref
}

/**
 * Git and pull request reads for a lane's checkout, through the
 * Host's git and GitHub features. `git.info` is the lane's own summary.
 */
export function gitHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  const summary = (ctx: OpHandlerContext) => {
    const lane = targetLane(ctx)
    const found = requireRuntime(deps.laneRuntime).summaryFor(lane.laneId)
    if (!found) throw new OpRefusal('unavailable', 'That lane is unavailable on this machine.')
    return found
  }
  const call = async (method: string, params: unknown) =>
    dataResult(await laneCall(deps.lanes, method, params))
  return {
    ...gitMutationHandlers(deps),
    ...worktreeHandlers(deps),
    'git.diff': op<{ path?: string }>(async ({ path }, ctx) => {
      const { diff } = (await laneCall(
        deps.lanes,
        'git.diff',
        {
          laneId: targetLane(ctx).laneId,
          ...(path ? { path } : {}),
        },
        ctx.signal,
      )) as { diff: string }
      // Limit by code points so a page never shortens a chunk or splits a surrogate pair.
      const chars = Array.from(diff)
      const rows = Array.from({ length: Math.ceil(chars.length / 1500) }, (_, i) => ({
        chunk: chars.slice(i * 1500, (i + 1) * 1500).join(''),
      }))
      const page = pageInventory(rows, ctx, fields('chunk'))
      return { ...page, text: page.data.map((r) => r.chunk).join('') || 'No changes on this page.' }
    }),
    'git.branches': op(async (_a, ctx) => {
      const cwd = await laneRoot(deps, targetLane(ctx).laneId).catch(gitRefusal)
      const { branches } = await listBranches(cwd, ownerGit(ctx.signal), true).catch(gitRefusal)
      const rows = branches.map(({ name, isCurrent, worktreePath }) => ({
        ref: name,
        current: isCurrent,
        ...(worktreePath ? { path: worktreePath } : {}),
      }))
      return pageInventory(rows, ctx, fields('ref', 'current', 'path'))
    }),
    'git.worktrees': op(async (_a, ctx) => {
      const cwd = await laneRoot(deps, targetLane(ctx).laneId).catch(gitRefusal)
      const trees = await listWorktreeMetadata(cwd, ownerGit(ctx.signal)).catch(gitRefusal)
      const rows = trees.map(({ path, branch, isMain, locked, prunable }) => ({
        ref: path,
        branch,
        state: isMain ? 'main' : locked ? 'locked' : prunable ? 'stale' : 'linked',
      }))
      return pageInventory(rows, ctx, fields('ref', 'branch', 'state'))
    }),
    'git.info': op((_a, ctx) => {
      const { cwd, branch, worktree, repositoryId } = summary(ctx)
      return dataResult({ cwd, branch, worktree, repositoryId })
    }),
    'git.status': op((_a, ctx) => call('git.status', { laneId: targetLane(ctx).laneId })),
    'git.show': op<{ ref: string; path: string }>(({ ref, path }, ctx) =>
      call('git.show', { laneId: targetLane(ctx).laneId, path, ref }),
    ),
    'pr.list': op((_a, ctx) => call('github.prs', { repositoryId: summary(ctx).repositoryId })),
    'pr.status': op<{ refs: string[] }>(({ refs }, ctx) => {
      targetLane(ctx)
      if (refs.length > PR_SUMMARY_BATCH_SIZE)
        throw new OpRefusal('bad-request', `Ask about at most ${PR_SUMMARY_BATCH_SIZE} PRs.`)
      return call('github.prSummaries', { refs: refs.map(prRef), options: {} })
    }),
    'pr.detail': op<{ ref: string }>(({ ref }, ctx) => {
      targetLane(ctx)
      return call('github.prDetail', { ref: prRef(ref), options: {} })
    }),
  }
}
