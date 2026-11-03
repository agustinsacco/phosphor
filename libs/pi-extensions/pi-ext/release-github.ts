import type { Run } from './release-lease'

/** The repository's release policy, written by the release-setup skill. */
export const POLICY_PATH = '.github/release-manager.md'

export interface Policy {
  base: string
  merge: 'squash' | 'merge' | 'rebase'
}

/** The two fields the extension acts on. The manager reads the rest itself. */
export function parsePolicy(text: string): Policy {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const field = (name: string) =>
    new RegExp(`^${name}:[ \\t]*['"]?([^'"\\s#]+)`, 'm').exec(front)?.[1]
  const base = field('base')
  const merge = field('merge')
  return {
    base: base && /^[\w./-]+$/.test(base) && !base.startsWith('-') ? base : 'main',
    merge: merge === 'merge' || merge === 'rebase' ? merge : 'squash',
  }
}

/** The policy as origin's base branch has it now, not as this checkout last saw it. */
export async function originPolicy(git: Run, base: string): Promise<Policy> {
  const tracking = `refs/remotes/origin/${base}`
  await git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${base}:${tracking}`])
  let text: string
  try {
    text = await git(['show', `${tracking}:${POLICY_PATH}`])
  } catch {
    throw new Error(`origin/${base} has no ${POLICY_PATH}. Run /skill:release-setup first.`)
  }
  return parsePolicy(text)
}

interface Check {
  status?: string
  conclusion?: string | null
  state?: string
}

interface PullRequest {
  number: number
  headRefOid: string
  isDraft: boolean
  baseRefName: string
  mergeable: string
  labels: Array<{ name: string }>
  statusCheckRollup: Check[] | null
}

const PR_LIMIT = 100

const FAILED = /^(FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE)$/

/** Coarse on purpose: a check moving from queued to running is not news. */
export function rollup(
  checks: readonly Check[] | null,
): 'none' | 'pending' | 'failing' | 'passing' {
  if (!checks?.length) return 'none'
  let pending = false
  for (const check of checks) {
    const outcome = (check.conclusion || check.state || '').toUpperCase()
    if (FAILED.test(outcome)) return 'failing'
    const running = !!check.status && check.status.toUpperCase() !== 'COMPLETED'
    if (running || !outcome || outcome === 'PENDING' || outcome === 'EXPECTED') pending = true
  }
  return pending ? 'pending' : 'passing'
}

/** One line per fact a pass acts on. Comments and other labels do not start passes. */
export function queueLines(prs: PullRequest[], base: string, head: string, ci: string): string[] {
  const lines = [...prs]
    .sort((a, b) => a.number - b.number)
    .map((pr) => {
      const labels = pr.labels
        .map((label) => label.name)
        .filter((name) => name.startsWith('rm:'))
        .sort()
      return [
        `#${pr.number}`,
        pr.headRefOid.slice(0, 7),
        ...(pr.baseRefName === base ? [] : [`onto ${pr.baseRefName}`]),
        pr.isDraft ? 'draft' : 'ready',
        // GitHub computes mergeability lazily; only a conflict is news.
        ...(pr.mergeable === 'CONFLICTING' ? ['conflicting'] : []),
        `checks ${rollup(pr.statusCheckRollup)}`,
        ...labels,
      ].join(' ')
    })
  return [`${base} ${head.slice(0, 7)} ${ci || 'no runs'}`, ...lines]
}

/** Each workflow's latest run on the base branch's head, as `name: state`. */
export function baseRuns(
  runs: Array<Check & { headSha: string; workflowName?: string }>,
  head: string,
): string {
  const latest = new Map<string, Check>()
  for (const run of runs)
    if (run.headSha === head && !latest.has(run.workflowName ?? 'CI'))
      latest.set(run.workflowName ?? 'CI', run)
  return [...latest]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, run]) => `${name}: ${rollup([run])}`)
    .join(', ')
}

export interface Queue {
  lines: string[]
  /** Some pull request could move without the user: worth a periodic sweep. */
  actionable: boolean
}

export async function readQueue(gh: Run, git: Run, base: string): Promise<Queue> {
  const [prs, runs, ref] = await Promise.all([
    gh([
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      String(PR_LIMIT),
      '--json',
      'number,headRefOid,isDraft,baseRefName,mergeable,labels,statusCheckRollup',
    ]),
    gh([
      'run',
      'list',
      '--branch',
      base,
      '--limit',
      '20',
      '--json',
      'headSha,status,conclusion,workflowName',
    ]),
    git(['ls-remote', 'origin', `refs/heads/${base}`]),
  ])
  const open = JSON.parse(prs) as PullRequest[]
  const head = ref.split(/\s/)[0] ?? ''
  const ci = baseRuns(JSON.parse(runs) as Array<Check & { headSha: string }>, head)
  const waiting = (pr: PullRequest) =>
    pr.isDraft ||
    rollup(pr.statusCheckRollup) === 'pending' ||
    pr.labels.some((label) => label.name === 'rm:hold' || label.name === 'rm:blocked')
  const lines = queueLines(open, base, head, ci)
  if (open.length >= PR_LIMIT)
    lines.push(
      `Only the first ${PR_LIMIT} open pull requests are listed: read the rest with gh pr list.`,
    )
  return { lines, actionable: open.some((pr) => !waiting(pr)) }
}

/** What changed between two passes: new facts, then facts that went away. */
export function queueChanges(before: readonly string[], after: readonly string[]): string[] {
  const old = new Set(before)
  const now = new Set(after)
  return [
    ...after.filter((line) => !old.has(line)).map((line) => `+ ${line}`),
    ...before.filter((line) => !now.has(line)).map((line) => `- ${line}`),
  ]
}

/**
 * Refuse a pull request whose reviewed commit is no longer its head, or that
 * touches the policy. Judged by local git on the commit itself, renames and
 * deletions included, rather than by a listing of whatever the head is now.
 */
export async function checkPolicyUntouched(
  git: Run,
  local: string,
  pr: number,
  head: string,
  base: string,
): Promise<void> {
  const pull = `${local}-pull`
  const tracking = `refs/remotes/origin/${base}`
  await git([
    'fetch',
    '--quiet',
    '--no-tags',
    'origin',
    `+refs/pull/${pr}/head:${pull}`,
    `+refs/heads/${base}:${tracking}`,
  ])
  const fetched = (await git(['rev-parse', '--verify', `${pull}^{commit}`])).trim()
  if (fetched !== head)
    throw new Error(
      `Not merged: #${pr}'s head is now ${fetched.slice(0, 7)}, not the ${head.slice(0, 7)} you reviewed. Review it again.`,
    )
  const files = await git(['diff', '--no-renames', '--name-only', `${tracking}...${pull}`])
  if (files.split('\n').some((file) => file.trim() === POLICY_PATH))
    throw new Error(`Not merged: #${pr} changes ${POLICY_PATH}. Ask the user.`)
}

export function mergeArgs(pr: number, head: string, policy: Policy): string[] {
  return ['pr', 'merge', String(pr), `--${policy.merge}`, '--match-head-commit', head]
}
