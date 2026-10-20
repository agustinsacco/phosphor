import type { GhChecks, GhPullRequest, GhRepoPullRequests } from '@phosphor/shared/models'

export type GhRunner = (cwd: string, args: string[]) => Promise<string | null>

/**
 * One rollup entry is either a CheckRun (`conclusion`/`status`) or a
 * StatusContext (`state`). Normalizing both keeps the summary honest when a
 * repo mixes GitHub Actions with external status reporters.
 */
interface RollupEntry {
  __typename?: string
  status?: string
  conclusion?: string
  state?: string
}

export function summarizeChecks(rollup: RollupEntry[] | undefined): GhChecks | undefined {
  if (!rollup || rollup.length === 0) return undefined
  let passed = 0
  let failed = 0
  let pending = 0
  const IN_FLIGHT = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED'])
  const BENIGN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
  for (const entry of rollup) {
    // CheckRun reports status+conclusion; StatusContext reports only `state`,
    // where PENDING is the in-flight signal (there is no `status` to consult).
    const verdict = (entry.conclusion || entry.state || '').toUpperCase()
    const status = (entry.status || '').toUpperCase()
    if (IN_FLIGHT.has(status) || IN_FLIGHT.has(verdict) || !verdict) {
      pending++
    } else if (BENIGN.has(verdict)) {
      passed++
    } else {
      failed++
    }
  }
  return { passed, failed, pending, total: rollup.length }
}

interface RawPr {
  number?: number
  title?: string
  state?: string
  url?: string
  isDraft?: boolean
  mergeable?: string
  mergeStateStatus?: string
  statusCheckRollup?: RollupEntry[]
  reviewDecision?: string
  headRefName?: string
}

/** The `--json` field set both queries request. */
const PR_FIELDS = 'number,title,state,url,isDraft'
const PR_DETAILS = 'mergeable,mergeStateStatus,reviewDecision,statusCheckRollup'

/**
 * CI-heavy repositories can exceed GitHub's GraphQL resource budget even
 * with just 100 PRs. Retry with identity and state only, not with a smaller
 * PR limit that would silently hide lanes. Both attempts use the caller's cwd.
 */
async function listPrs(
  gh: GhRunner,
  repoPath: string,
  args: string[],
  fields: string,
): Promise<{ rows: RawPr[]; checksAvailable: boolean } | null> {
  for (const checksAvailable of [true, false]) {
    const raw = await gh(repoPath, [
      'pr',
      'list',
      ...args,
      '--json',
      checksAvailable ? `${fields},${PR_DETAILS}` : fields,
    ])
    if (raw === null) continue
    try {
      const rows: unknown = JSON.parse(raw)
      if (
        Array.isArray(rows) &&
        rows.every((row) => row && typeof row === 'object' && toPullRequest(row))
      ) {
        return { rows, checksAvailable }
      }
    } catch {
      // Malformed output is unavailable, never proof of an empty repo.
    }
  }
  return null
}

/** Shared shaping so the single-branch and whole-repo queries cannot diverge. */
export function toPullRequest(pr: RawPr | undefined): GhPullRequest | null {
  if (!pr?.number || !pr.url) return null
  return {
    number: pr.number,
    title: pr.title ?? '',
    // gh reports OPEN | CLOSED | MERGED; draft is a separate flag.
    state:
      pr.isDraft && pr.state === 'OPEN'
        ? 'DRAFT'
        : ((pr.state ?? 'OPEN') as GhPullRequest['state']),
    url: pr.url,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    checks: summarizeChecks(pr.statusCheckRollup),
    reviewDecision: pr.reviewDecision as GhPullRequest['reviewDecision'],
  }
}

/** An open PR outranks a closed one; otherwise the newest number wins. */
export function preferPr(a: GhPullRequest, b: GhPullRequest): GhPullRequest {
  const live = (pr: GhPullRequest): number => (pr.state === 'OPEN' || pr.state === 'DRAFT' ? 1 : 0)
  if (live(a) !== live(b)) return live(a) > live(b) ? a : b
  return a.number >= b.number ? a : b
}

/**
 * The open-or-most-recent PR for a branch, or null when there is none.
 *
 * `gh pr list --head` is deliberate: unlike `gh pr view`, it exits 0 with `[]`
 * when no PR exists, so "no PR" doesn't have to be inferred from an error.
 */
export async function ghPrForBranch(
  gh: GhRunner,
  repoPath: string,
  branch: string,
): Promise<GhPullRequest | null> {
  if (!branch) return null
  const result = await listPrs(
    gh,
    repoPath,
    ['--head', branch, '--state', 'all', '--limit', '1'],
    PR_FIELDS,
  )
  const pr = toPullRequest(result?.rows[0])
  if (pr && !result?.checksAvailable) pr.checks = null
  return pr
}

/**
 * Every recent PR in a repo, indexed by head branch.
 *
 * The sidebar shows a PR chip per lane, and a lane is a branch — so the naive
 * shape is one `ghPrForBranch` per row. That is 8-20 `gh` subprocesses per
 * refresh on a normal workspace. This is the batched sibling, with at most
 * two queries for the whole group, regardless of the workspace or lane count.
 *
 * The limit is a real cap: a full page cannot prove absence for older lanes.
 * A failed query returns null, which also must never imply "no PR".
 */
export async function ghPrsForRepo(
  gh: GhRunner,
  repoPath: string,
  limit = 100,
): Promise<GhRepoPullRequests | null> {
  const result = await listPrs(
    gh,
    repoPath,
    ['--state', 'all', '--limit', String(limit)],
    `${PR_FIELDS},headRefName`,
  )
  if (!result) return null
  const byBranch = indexPrsByBranch(result.rows)
  if (!result.checksAvailable) {
    for (const pr of Object.values(byBranch)) pr.checks = null
  }
  return { byBranch, complete: result.rows.length < limit }
}

/** Exported for tests: fixture JSON in, branch-keyed map out. */
export function indexPrsByBranch(rows: RawPr[]): Record<string, GhPullRequest> {
  const byBranch: Record<string, GhPullRequest> = {}
  for (const row of rows) {
    const branch = row.headRefName
    if (!branch) continue
    const pr = toPullRequest(row)
    if (!pr) continue
    const existing = byBranch[branch]
    byBranch[branch] = existing ? preferPr(existing, pr) : pr
  }
  return byBranch
}
