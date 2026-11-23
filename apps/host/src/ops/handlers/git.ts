import { parsePrUrl, PR_SUMMARY_BATCH_SIZE } from '@phosphor/shared/github-pr-refs'
import type { GhPrRef } from '@phosphor/shared/models'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { dataResult, op } from '@phosphor/session-runtime/ops/results'
import type { OpHandler, OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import type { DaemonHandlerDeps } from './index'
import { laneCall, requireRuntime, targetLane } from './lane-target'

function prRef(text: string): GhPrRef {
  const ref = parsePrUrl(text.trim())
  if (!ref) throw new OpRefusal('bad-request', `Name the pull request by its URL: ${text}`)
  return ref
}

/**
 * Read-only git and pull request status for a lane's checkout, through the
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
