import type { GhPullRequest, GitInfo, SessionMeta } from '@shared/models'

/**
 * What a bulk delete would do to one lane, and what should stop it.
 *
 * Running turns are cancellable, not undeletable. Lost work and interrupted
 * turns raise one acknowledgement for the selection before processes stop.
 *
 * Pure so the whole matrix is testable without a store or a modal, per the
 * repo's prefer-pure-logic rule.
 */
export interface LanePreflight {
  path: string
  title: string
  marker: string
  branch?: string
  worktreePath?: string
  mainRepoPath?: string
  /** Lost-work reasons; empty when the lane is clean and idle. */
  warnings: Array<'uncommitted' | 'unpushed' | 'open-pr' | 'running'>
  pr?: GhPullRequest
  dirtyCount: number
}

export interface PreflightSummary {
  lanes: LanePreflight[]
  /** Lanes that will actually be deleted. */
  deletable: LanePreflight[]
  /** Distinct warning reasons across the deletable set. */
  warnings: LanePreflight['warnings']
  /** True when the user must acknowledge before the delete is allowed. */
  needsAcknowledgement: boolean
  /** Deletable lanes that sit in their own worktree. */
  worktreeCount: number
}

export function classifyLane(input: {
  meta: SessionMeta
  title: string
  marker: string
  git?: GitInfo
  pr?: GhPullRequest
  isLive: boolean
  isStreaming: boolean
}): LanePreflight {
  const { meta, git, pr } = input
  const warnings: LanePreflight['warnings'] = []
  if (input.isStreaming) warnings.push('running')
  if (git?.dirtyCount) warnings.push('uncommitted')
  if (git?.ahead) warnings.push('unpushed')
  if (pr && (pr.state === 'OPEN' || pr.state === 'DRAFT')) warnings.push('open-pr')

  return {
    path: meta.path,
    title: input.title,
    marker: input.marker,
    branch: git?.branch,
    // Only a linked worktree has a directory of its own to remove. Deleting a
    // session that runs in the MAIN checkout must never offer to remove it.
    worktreePath: git?.isWorktree ? meta.cwd : undefined,
    mainRepoPath: git?.mainRepoPath,
    warnings,
    pr,
    dirtyCount: git?.dirtyCount ?? 0,
  }
}

export function summarizePreflight(lanes: LanePreflight[]): PreflightSummary {
  const deletable = lanes
  const warnings = [...new Set(deletable.flatMap((lane) => lane.warnings))]
  return {
    lanes,
    deletable,
    warnings,
    needsAcknowledgement: warnings.length > 0,
    worktreeCount: deletable.filter((lane) => lane.worktreePath && lane.mainRepoPath).length,
  }
}

const WARNING_TEXT: Record<LanePreflight['warnings'][number], string> = {
  running: 'a turn in progress that will be stopped',
  uncommitted: 'uncommitted changes',
  unpushed: 'unpushed commits',
  'open-pr': 'an open PR',
}

/** Human sentence for the acknowledgement, listing only what actually applies. */
export function describeWarnings(warnings: PreflightSummary['warnings']): string {
  return warnings.map((w) => WARNING_TEXT[w]).join(', ')
}
