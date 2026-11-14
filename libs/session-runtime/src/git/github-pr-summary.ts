import type {
  GhPrCheck,
  GhPrCheckState,
  GhPrKey,
  GhPrRef,
  GhPrReviewer,
  GhPrSummary,
} from '@phosphor/shared/models'
import { prKey } from '@phosphor/shared/github-pr-refs'
import { toPullRequest } from './github'
import { GithubFailure, type GithubCommand } from './github-command'

/** A check run or a commit status, as GraphQL returns either. */
export interface RawContext {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string | null
  state?: string
  isRequired?: boolean
  title?: string | null
  detailsUrl?: string | null
  targetUrl?: string | null
}
export interface RawLogin {
  __typename?: string
  login?: string
  slug?: string
}
export interface RawSummary {
  number?: number
  title?: string
  url?: string
  state?: string
  isDraft?: boolean
  headRefName?: string
  baseRefName?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  updatedAt?: string
  mergedAt?: string | null
  closedAt?: string | null
  mergeable?: string
  mergeStateStatus?: string
  reviewDecision?: string | null
  isInMergeQueue?: boolean
  autoMergeRequest?: object | null
  author?: RawLogin | null
  headRefOid?: string
  comments?: { totalCount?: number }
  reviewThreads?: { totalCount?: number; nodes?: { isResolved?: boolean }[] }
  latestOpinionatedReviews?: { nodes?: { state?: string; author?: RawLogin | null }[] }
  reviewRequests?: { nodes?: { asCodeOwner?: boolean; requestedReviewer?: RawLogin | null }[] }
  commits?: {
    nodes?: {
      commit?: {
        statusCheckRollup?: {
          contexts?: { pageInfo?: { hasNextPage?: boolean }; nodes?: RawContext[] }
        } | null
      }
    }[]
  }
}

const CORE = `number title url state isDraft headRefName baseRefName additions deletions changedFiles
updatedAt mergedAt closedAt mergeable mergeStateStatus reviewDecision isInMergeQueue
autoMergeRequest{enabledAt} author{login} headRefOid comments{totalCount}
reviewThreads(first:100){totalCount nodes{isResolved}}
latestOpinionatedReviews(first:20){nodes{state author{login}}}
reviewRequests(first:20){nodes{asCodeOwner requestedReviewer{__typename
  ... on User{login} ... on Team{slug} ... on Bot{login} ... on Mannequin{login}}}}`

/** `isRequired` is asked per PR: branch protection depends on the base branch. */
const CHECKS = (number: number) => `commits(last:1){nodes{commit{statusCheckRollup{
  contexts(first:100){pageInfo{hasNextPage} nodes{__typename
    ... on CheckRun{name status conclusion title detailsUrl isRequired(pullRequestNumber:${number})}
    ... on StatusContext{context state targetUrl isRequired(pullRequestNumber:${number})}}}}}}}`

export function summaryQuery(refs: GhPrRef[], withChecks: boolean): string {
  const { owner, repo } = refs[0]!
  const fields = refs
    .map(
      (ref) =>
        `p${ref.number}:pullRequest(number:${ref.number}){${CORE} ${withChecks ? CHECKS(ref.number) : ''}}`,
    )
    .join(' ')
  return `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}){${fields}}}`
}

const IN_FLIGHT = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED'])

export function checkState(raw: RawContext): GhPrCheckState {
  const verdict = (raw.conclusion || raw.state || '').toUpperCase()
  if (IN_FLIGHT.has((raw.status || '').toUpperCase()) || IN_FLIGHT.has(verdict) || !verdict)
    return 'pending'
  if (verdict === 'SUCCESS') return 'success'
  if (verdict === 'NEUTRAL') return 'neutral'
  if (verdict === 'SKIPPED') return 'skipped'
  return 'failure'
}

export const https = (value: unknown): string | undefined =>
  typeof value === 'string' && value.startsWith('https://') && value.length <= 2048
    ? value
    : undefined
export const short = (value: unknown, max = 200): string | undefined =>
  typeof value === 'string' && value ? value.slice(0, max) : undefined
export const nameOf = (login: RawLogin | null | undefined): string | undefined =>
  short(login?.login ?? login?.slug, 100)

export function toCheck(raw: RawContext): GhPrCheck | null {
  const name = short(raw.name ?? raw.context)
  if (!name) return null
  const check: GhPrCheck = { name, state: checkState(raw), required: raw.isRequired === true }
  const title = short(raw.title)
  const url = https(raw.detailsUrl ?? raw.targetUrl)
  if (title) check.title = title
  if (url) check.url = url
  return check
}

/** Shape one PR, or null when GitHub's answer is not a PR at all. */
export function toSummary(ref: GhPrRef, raw: RawSummary, withChecks: boolean): GhPrSummary | null {
  const contexts = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts
  const nodes = contexts?.nodes ?? []
  const base = toPullRequest({
    ...raw,
    reviewDecision: raw.reviewDecision ?? undefined,
    statusCheckRollup: nodes.map((n) => ({
      status: n.status,
      conclusion: n.conclusion ?? undefined,
      state: n.state,
    })),
  })
  if (!base || raw.number !== ref.number) return null
  const truncated = contexts?.pageInfo?.hasNextPage === true
  // Unknown or partial checks must never read as passing.
  if (!withChecks || truncated) base.checks = null
  const reviews = raw.latestOpinionatedReviews?.nodes ?? []
  const by = (state: string) =>
    reviews.flatMap((r) => (r.state === state && nameOf(r.author) ? [nameOf(r.author)!] : []))
  const waitingOn: GhPrReviewer[] = (raw.reviewRequests?.nodes ?? [])
    .flatMap((r) => {
      const name = nameOf(r.requestedReviewer)
      if (!name) return []
      const team = r.requestedReviewer?.__typename === 'Team'
      return [{ name, team, codeOwner: r.asCodeOwner === true }]
    })
    .sort((a, b) => Number(b.codeOwner) - Number(a.codeOwner))
  const threads = raw.reviewThreads
  const count = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : 0)
  return {
    ...base,
    ref: { ...ref },
    headRefName: short(raw.headRefName, 255) ?? '',
    baseRefName: short(raw.baseRefName, 255) ?? '',
    additions: count(raw.additions),
    deletions: count(raw.deletions),
    changedFiles: count(raw.changedFiles),
    comments: count(raw.comments?.totalCount),
    updatedAt: short(raw.updatedAt, 40) ?? '',
    ...(raw.mergedAt ? { mergedAt: short(raw.mergedAt, 40) } : {}),
    ...(raw.closedAt ? { closedAt: short(raw.closedAt, 40) } : {}),
    ...(nameOf(raw.author) ? { author: nameOf(raw.author) } : {}),
    ...(raw.headRefOid ? { headSha: short(raw.headRefOid, 64) } : {}),
    checkRuns: withChecks ? nodes.flatMap((n) => toCheck(n) ?? []) : null,
    checksTruncated: truncated,
    approvedBy: by('APPROVED'),
    changesRequestedBy: by('CHANGES_REQUESTED'),
    waitingOn,
    threads:
      threads && count(threads.totalCount) <= 100
        ? {
            total: count(threads.totalCount),
            unresolved: (threads.nodes ?? []).filter((t) => t.isResolved === false).length,
          }
        : null,
    inMergeQueue: raw.isInMergeQueue === true,
    autoMerge: !!raw.autoMergeRequest,
  }
}

/**
 * One repository's PRs by number. A value of null means GitHub said that
 * number does not exist; a missing key means this read could not tell.
 */
export function parseSummaries(
  body: unknown,
  refs: GhPrRef[],
  withChecks: boolean,
): Map<GhPrKey, GhPrSummary | null> {
  const value = body as {
    data?: { repository?: Record<string, RawSummary | null> | null }
    errors?: { type?: string; path?: unknown[] }[]
  }
  const repository = value?.data?.repository
  if (!repository) throw new GithubFailure('unavailable')
  const missing = new Set(
    (value.errors ?? []).flatMap((e) =>
      e.type === 'NOT_FOUND' && e.path?.[0] === 'repository' && typeof e.path[1] === 'string'
        ? [e.path[1]]
        : [],
    ),
  )
  const found = new Map<GhPrKey, GhPrSummary | null>()
  for (const ref of refs) {
    const alias = `p${ref.number}`
    const raw = repository[alias]
    if (raw === null && missing.has(alias)) found.set(prKey(ref), null)
    else if (raw) {
      const summary = toSummary(ref, raw, withChecks)
      if (summary) found.set(prKey(ref), summary)
    }
  }
  return found
}

/** Up to 20 PRs of one repository in one query, with the lighter retry GitHub sometimes needs. */
export async function readSummaries(
  run: GithubCommand,
  cwd: string,
  refs: GhPrRef[],
  signal: AbortSignal,
): Promise<Map<GhPrKey, GhPrSummary | null>> {
  for (const withChecks of [true, false]) {
    const query = summaryQuery(refs, withChecks)
    const host = refs[0]!.host
    const args = ['api', 'graphql', '--hostname', host, '--include', '-f', `query=${query}`]
    const result = await run(cwd, args, signal)
    if (result.ok) return parseSummaries(JSON.parse(result.stdout), refs, withChecks)
    if (!withChecks || !result.retryWithoutChecks || signal.aborted)
      throw new GithubFailure(result.reason, result.retryWithoutChecks)
  }
  return new Map()
}
