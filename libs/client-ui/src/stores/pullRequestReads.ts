import { PR_READ_BATCH_SIZE } from '@shared/host-protocol-github'
import type { GhBranchCoverage, GhRepoPullRequests } from '@shared/models'
import type { RepoPullRequests } from './pullRequests'

/** A refresh tick is bounded even for repositories with hundreds of lanes. */
export function pullRequestPages(
  interests: { branches: string[]; activeBranch?: string },
  current: RepoPullRequests,
): string[][] {
  const attempted = (branch: string): number =>
    current.branchAttemptedAt?.[branch] ?? current.coverage?.[branch]?.attemptedAt ?? 0
  const branches = [...interests.branches]
    .sort((a, b) =>
      a === interests.activeBranch
        ? -1
        : b === interests.activeBranch
          ? 1
          : attempted(a) - attempted(b),
    )
    .slice(0, PR_READ_BATCH_SIZE * 4)
  const pages: string[][] = []
  for (let i = 0; i < branches.length; i += PR_READ_BATCH_SIZE)
    pages.push(branches.slice(i, i + PR_READ_BATCH_SIZE))
  return pages
}

export function mergePullRequestRead(
  current: RepoPullRequests,
  result: GhRepoPullRequests | null,
  branches: string[],
  now: number,
): RepoPullRequests {
  const branchAttemptedAt = {
    ...current.branchAttemptedAt,
    ...Object.fromEntries(branches.map((branch) => [branch, now])),
  }
  if (!result && !current.coverage) return { ...current, branchAttemptedAt, failed: true }
  // Old Hosts have no branch coverage: a complete listing replaces the known PRs, a truncated one adds to them.
  if (result && !result.coverage)
    return {
      ...current,
      byBranch: result.complete ? result.byBranch : { ...current.byBranch, ...result.byBranch },
      coverage: undefined,
      branchAttemptedAt,
      fetchedAt: now,
    }
  const coverage: Record<string, GhBranchCoverage> = Object.assign(
    Object.create(null),
    current.coverage,
    result?.coverage,
  )
  for (const branch of branches.length ? branches : result ? [] : Object.keys(coverage)) {
    if (result?.coverage?.[branch]) continue
    coverage[branch] = {
      state: 'unavailable',
      checkedAt: current.coverage?.[branch]?.checkedAt ?? 0,
      attemptedAt: now,
      reason: 'unavailable',
    }
  }
  const byBranch = { ...current.byBranch, ...result?.byBranch }
  for (const [branch, value] of Object.entries(coverage))
    if (value.state === 'absent') delete byBranch[branch]
  return {
    ...current,
    byBranch,
    coverage,
    branchAttemptedAt,
    fetchedAt: result ? now : current.fetchedAt,
    failed:
      current.failed ||
      !result ||
      Object.values(result.coverage ?? {}).some((c) => c.state === 'unavailable'),
  }
}
