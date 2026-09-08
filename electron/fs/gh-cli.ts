import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GhChecks, GhPullRequest } from '@shared/models'
import { piProcessEnv } from '../pi/shell-env'

const execFileAsync = promisify(execFile)

/**
 * GitHub awareness via the `gh` CLI.
 *
 * `gh` is used rather than the REST/GraphQL API on purpose: it already holds
 * the user's credentials (`gh auth`), respects their enterprise host config,
 * and needs no token stored by Phosphor. That also means every failure mode here
 * is *normal* — gh not installed, not authed, no remote, remote isn't GitHub —
 * so nothing in this module throws for those. Callers get `null` and the UI
 * simply shows no PR, because "this repo has no GitHub PR" is a state, not an
 * error worth interrupting anyone over.
 *
 * Read-only by design: no push, no create. Those are outward-facing writes and
 * belong behind an explicit, confirmed action.
 */

/**
 * Environment for every `gh` run, including the probe.
 *
 * A GUI launch inherits launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), and
 * `gh` is a Homebrew binary — so the packaged app probed `gh --version`, got
 * ENOENT, cached "unavailable" for the process lifetime, and never showed a PR
 * chip on any lane. `piProcessEnv` upgrades PATH to the login shell's, the
 * same way every other subprocess in the app resolves its binary.
 */
function ghEnv(): Promise<Record<string, string>> {
  // Never let gh open a browser or prompt from inside the app.
  return piProcessEnv({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' })
}

/** `gh` is slow to fail when absent; cache the probe for the process lifetime. */
let availability: Promise<boolean> | null = null

export function ghAvailable(): Promise<boolean> {
  availability ??= ghEnv()
    .then((env) => execFileAsync('gh', ['--version'], { timeout: 5_000, env }))
    .then(
      () => true,
      () => false,
    )
  return availability
}

async function gh(cwd: string, args: string[]): Promise<string | null> {
  if (!(await ghAvailable())) return null
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      env: await ghEnv(),
    })
    return stdout
  } catch {
    // Not a repo, no remote, unauthenticated, rate-limited — all "no PR info".
    return null
  }
}

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
const PR_FIELDS =
  'number,title,state,url,isDraft,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision'

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
  repoPath: string,
  branch: string,
): Promise<GhPullRequest | null> {
  if (!branch) return null
  const raw = await gh(repoPath, [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'all',
    '--limit',
    '1',
    '--json',
    PR_FIELDS,
  ])
  if (!raw) return null
  try {
    return toPullRequest((JSON.parse(raw) as RawPr[])[0])
  } catch {
    return null
  }
}

/**
 * Every recent PR in a repo, indexed by head branch.
 *
 * The sidebar shows a PR chip per lane, and a lane is a branch — so the naive
 * shape is one `ghPrForBranch` per row. That is 8-20 `gh` subprocesses per
 * refresh on a normal workspace. This is the batched sibling, the same way
 * `git:info` gained `git:infoBatch`: one subprocess for the whole group.
 *
 * The `--limit` is a real cap, not a formality: a repo with more open+closed
 * PRs than this resolves only the most recent ones, and older lanes render
 * with no chip rather than a wrong one. gh sorts newest-first, which is the
 * order that matches what is still open in the sidebar.
 */
export async function ghPrsForRepo(
  repoPath: string,
  limit = 100,
): Promise<Record<string, GhPullRequest>> {
  const raw = await gh(repoPath, [
    'pr',
    'list',
    '--state',
    'all',
    '--limit',
    String(limit),
    '--json',
    `${PR_FIELDS},headRefName`,
  ])
  if (!raw) return {}
  let parsed: RawPr[]
  try {
    parsed = JSON.parse(raw) as RawPr[]
  } catch {
    return {}
  }
  return indexPrsByBranch(parsed)
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
