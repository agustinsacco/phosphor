import type {
  GhPrAnnotation,
  GhPrCheckDetail,
  GhPrDetail,
  GhPrEvent,
  GhPrKey,
  GhPrRef,
  GhPrThread,
} from '@phosphor/shared/models'
import { isPrRef, parsePrSummaryOptions, prKey } from '@phosphor/shared/github-pr-refs'
import { GithubFailure } from './github-command'
import type { GithubGate } from './github-gate'
import { nameOf, short, toCheck, type RawContext, type RawLogin } from './github-pr-summary'

/**
 * One PR's inspector detail: unresolved threads with their first comment,
 * every check with its workflow, timing and first annotations, who only
 * commented, and the recent timeline. Read for the PR the inspector shows,
 * about two GitHub points.
 */

const MAX_THREADS = 30
const FRESH = 15_000
const FORCE_FLOOR = 5_000
const MAX_ENTRIES = 50

interface RawDetailContext extends RawContext {
  startedAt?: string | null
  completedAt?: string | null
  createdAt?: string | null
  description?: string | null
  checkSuite?: { workflowRun?: { workflow?: { name?: string } | null } | null } | null
  annotations?: {
    nodes?: {
      path?: string
      annotationLevel?: string
      message?: string
      location?: { start?: { line?: number } }
    }[]
  }
}
interface RawThread {
  isResolved?: boolean
  isOutdated?: boolean
  path?: string
  line?: number | null
  originalLine?: number | null
  comments?: {
    totalCount?: number
    nodes?: { author?: RawLogin | null; bodyText?: string; url?: string }[]
  }
}
interface RawEvent {
  __typename?: string
  state?: string
  submittedAt?: string
  createdAt?: string
  author?: RawLogin | null
  actor?: RawLogin | null
  commit?: { committedDate?: string; messageHeadline?: string; author?: { user?: RawLogin | null } }
  requestedReviewer?: RawLogin | null
}
interface RawDetail {
  number?: number
  reviewThreads?: { totalCount?: number; nodes?: RawThread[] }
  latestReviews?: { nodes?: { state?: string; author?: RawLogin | null }[] }
  timelineItems?: { nodes?: RawEvent[] }
  commits?: {
    nodes?: {
      commit?: {
        statusCheckRollup?: {
          contexts?: { pageInfo?: { hasNextPage?: boolean }; nodes?: RawDetailContext[] }
        } | null
      }
    }[]
  }
}

const TIMELINE = `timelineItems(last:20,itemTypes:[PULL_REQUEST_REVIEW,PULL_REQUEST_COMMIT,
  HEAD_REF_FORCE_PUSHED_EVENT,REVIEW_REQUESTED_EVENT,READY_FOR_REVIEW_EVENT,MERGED_EVENT,
  CLOSED_EVENT,REOPENED_EVENT]){nodes{__typename
  ... on PullRequestReview{state submittedAt author{login}}
  ... on PullRequestCommit{commit{committedDate messageHeadline author{user{login}}}}
  ... on HeadRefForcePushedEvent{createdAt actor{login}}
  ... on ReviewRequestedEvent{createdAt actor{login} requestedReviewer{__typename
    ... on User{login} ... on Team{slug} ... on Bot{login} ... on Mannequin{login}}}
  ... on ReadyForReviewEvent{createdAt actor{login}}
  ... on MergedEvent{createdAt actor{login}}
  ... on ClosedEvent{createdAt actor{login}}
  ... on ReopenedEvent{createdAt actor{login}}}}`

export function detailQuery(ref: GhPrRef): string {
  const n = ref.number
  return `query{repository(owner:${JSON.stringify(ref.owner)},name:${JSON.stringify(ref.repo)}){
pullRequest(number:${n}){number
reviewThreads(first:100){totalCount nodes{isResolved isOutdated path line originalLine
  comments(first:1){totalCount nodes{author{login} bodyText url}}}}
latestReviews(first:30){nodes{state author{login}}}
${TIMELINE}
commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename
  ... on CheckRun{name status conclusion title detailsUrl startedAt completedAt
    isRequired(pullRequestNumber:${n}) checkSuite{workflowRun{workflow{name}}}
    annotations(first:3){nodes{path annotationLevel message location{start{line}}}}}
  ... on StatusContext{context state targetUrl description createdAt
    isRequired(pullRequestNumber:${n})}}}}}}}}}}`
}

const line = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined

function toAnnotations(raw: RawDetailContext): GhPrAnnotation[] {
  return (raw.annotations?.nodes ?? []).flatMap((a) => {
    const message = short(a.message, 300)
    if (!message) return []
    const level = (a.annotationLevel ?? '').toLowerCase()
    const at = line(a.location?.start?.line)
    return [
      {
        path: short(a.path, 300) ?? '',
        ...(at ? { line: at } : {}),
        level: level === 'warning' || level === 'notice' ? level : 'failure',
        message,
      },
    ]
  })
}

function toCheckDetail(raw: RawDetailContext): GhPrCheckDetail | null {
  const check = toCheck({ ...raw, title: raw.title ?? raw.description })
  if (!check) return null
  const workflow = short(raw.checkSuite?.workflowRun?.workflow?.name, 120)
  const startedAt = short(raw.startedAt ?? raw.createdAt, 40)
  const completedAt = short(raw.completedAt, 40)
  return {
    ...check,
    ...(workflow ? { workflow } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    annotations: toAnnotations(raw),
  }
}

function toThread(raw: RawThread): GhPrThread | null {
  const first = raw.comments?.nodes?.[0]
  const body = short(first?.bodyText?.trim(), 500)
  const path = short(raw.path, 300)
  if (!body || !path) return null
  const total = raw.comments?.totalCount
  const at = line(raw.line) ?? line(raw.originalLine)
  const author = nameOf(first?.author)
  const url = short(first?.url, 2048)
  return {
    path,
    ...(at ? { line: at } : {}),
    outdated: raw.isOutdated === true,
    ...(author ? { author } : {}),
    body,
    replies: Number.isSafeInteger(total) ? Math.max(0, (total as number) - 1) : 0,
    ...(url?.startsWith('https://') ? { url } : {}),
  }
}

const EVENT_KIND: Record<string, GhPrEvent['kind']> = {
  PullRequestReview: 'review',
  PullRequestCommit: 'commit',
  HeadRefForcePushedEvent: 'force-push',
  ReviewRequestedEvent: 'requested',
  ReadyForReviewEvent: 'ready',
  MergedEvent: 'merged',
  ClosedEvent: 'closed',
  ReopenedEvent: 'reopened',
}

function toEvent(raw: RawEvent): GhPrEvent | null {
  const kind = EVENT_KIND[raw.__typename ?? '']
  const at = short(raw.submittedAt ?? raw.commit?.committedDate ?? raw.createdAt, 40)
  if (!kind || !at) return null
  const actor = nameOf(raw.author ?? raw.actor ?? raw.commit?.author?.user)
  const text =
    kind === 'commit'
      ? short(raw.commit?.messageHeadline, 200)
      : kind === 'requested'
        ? nameOf(raw.requestedReviewer)
        : undefined
  const state = kind === 'review' ? short(raw.state, 40) : undefined
  return {
    kind,
    at,
    ...(actor ? { actor } : {}),
    ...(state ? { state } : {}),
    ...(text ? { text } : {}),
  }
}

/** null: GitHub says the PR does not exist. Throws when the answer is unusable. */
export function parseDetail(body: unknown, ref: GhPrRef, now = Date.now()): GhPrDetail | null {
  const value = body as {
    data?: { repository?: { pullRequest?: RawDetail | null } | null }
    errors?: { type?: string }[]
  }
  const raw = value?.data?.repository?.pullRequest
  if (raw === null && value.errors?.some((e) => e.type === 'NOT_FOUND')) return null
  if (!raw || raw.number !== ref.number) throw new GithubFailure('unavailable')
  const open = (raw.reviewThreads?.nodes ?? []).filter((t) => t.isResolved === false)
  const threads = open.flatMap((t) => toThread(t) ?? [])
  const contexts = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts
  const commented = (raw.latestReviews?.nodes ?? []).flatMap((r) =>
    r.state === 'COMMENTED' && nameOf(r.author) ? [nameOf(r.author)!] : [],
  )
  return {
    ref: { ...ref },
    threads: threads.slice(0, MAX_THREADS),
    threadsTruncated: threads.length > MAX_THREADS || (raw.reviewThreads?.totalCount ?? 0) > 100,
    checks: contexts ? (contexts.nodes ?? []).flatMap((c) => toCheckDetail(c) ?? []) : null,
    checksTruncated: contexts?.pageInfo?.hasNextPage === true,
    commented: [...new Set(commented)],
    activity: (raw.timelineItems?.nodes ?? [])
      .flatMap((e) => toEvent(e) ?? [])
      .sort((a, b) => a.at.localeCompare(b.at)),
    checkedAt: now,
  }
}

interface Entry {
  detail?: GhPrDetail
  attemptedAt: number
  retryAt: number
  failures: number
}

export interface GithubPrDetailPorts {
  gate: GithubGate
  cwd: string
  budgetMs?: number
}

/** Detail by PR, reused for 15 seconds, coalesced, and kept through failures. */
class GithubPrDetailReader {
  private entries = new Map<GhPrKey, Entry>()
  private flights = new Map<GhPrKey, Promise<void>>()
  constructor(private ports: GithubPrDetailPorts) {}

  /** The last known detail, or null when there is none and GitHub did not answer. */
  async read(refValue: unknown, optionsValue?: unknown): Promise<GhPrDetail | null> {
    const options = parsePrSummaryOptions(optionsValue)
    if (!isPrRef(refValue) || !options) return null
    const ref: GhPrRef = { ...refValue }
    const key = prKey(ref)
    let flight = this.flights.get(key)
    if (!flight && this.due(key, options.force)) {
      flight = this.fetch(ref).finally(() => this.flights.delete(key))
      this.flights.set(key, flight)
    }
    await flight
    return this.entries.get(key)?.detail ?? null
  }

  private due(key: GhPrKey, force = false): boolean {
    const entry = this.entries.get(key)
    if (!entry) return true
    const now = Date.now()
    if (force && !entry.failures) return now - entry.attemptedAt >= FORCE_FLOOR
    return now >= entry.retryAt
  }

  private remember(key: GhPrKey, entry: Entry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  private async fetch(ref: GhPrRef): Promise<void> {
    const key = prKey(ref)
    const previous = this.entries.get(key)
    const now = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.ports.budgetMs ?? 20_000)
    timer.unref?.()
    try {
      // The renderer never chooses where gh connects: only hosts a checkout resolved.
      if (!this.ports.gate.trusts(ref.host)) throw new GithubFailure('unavailable')
      const query = `query=${detailQuery(ref)}`
      const args = ['api', 'graphql', '--hostname', ref.host, '--include', '-f', query]
      const result = await this.ports.gate.enqueue(() =>
        this.ports.gate.run(this.ports.cwd, args, controller.signal),
      )
      if (!result.ok) throw new GithubFailure(result.reason)
      const detail = parseDetail(JSON.parse(result.stdout), ref, Date.now())
      this.remember(key, {
        ...(detail ? { detail } : {}),
        attemptedAt: now,
        retryAt: now + FRESH,
        failures: 0,
      })
    } catch {
      const failures = (previous?.failures ?? 0) + 1
      const backoff = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(4, failures - 1))
      this.remember(key, { ...previous, attemptedAt: now, retryAt: now + backoff, failures })
    } finally {
      clearTimeout(timer)
    }
  }
}

export const createGithubPrDetailReader = (ports: GithubPrDetailPorts) =>
  new GithubPrDetailReader(ports)
export type { GithubPrDetailReader }
