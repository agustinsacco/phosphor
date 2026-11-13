import { isPrRef, prKey } from './github-pr-refs'
import { isHttpsUrl, parseCoverage, parsePullRequest } from './host-protocol-github'
import type {
  GhBranchCoverage,
  GhPrAnnotation,
  GhPrCheck,
  GhPrCheckDetail,
  GhPrDetail,
  GhPrEvent,
  GhPrKey,
  GhPrRead,
  GhPrRef,
  GhPrReviewer,
  GhPrSummary,
  GhPrThread,
} from './models'

/**
 * What a client accepts from a Host's `github.prSummaries` and
 * `github.prDetail`: the shapes This Mac's readers build, bounded, every link
 * https without credentials, and only the PRs that were asked for.
 */

type Rec = Record<string, unknown>
const record = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const text = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max
const flag = (v: unknown): v is boolean => typeof v === 'boolean'
const optional = (v: unknown, valid: (x: unknown) => boolean) => v === undefined || valid(v)
const names = (v: unknown, max = 100): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((name) => text(name, 200))

function list<T>(v: unknown, max: number, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  const out: T[] = []
  for (const item of v) {
    const parsed = parse(item)
    if (!parsed) return null
    out.push(parsed)
  }
  return out
}

/** A link only when it is https without credentials; anything else is dropped, not fatal. */
const link = (v: Rec): { url?: string } => (isHttpsUrl(v.url) ? { url: v.url } : {})

/** Copy the optional fields that are present; the caller has validated them. */
function pick<T>(v: Rec, keys: readonly string[]): Partial<T> {
  const out: Rec = {}
  for (const key of keys) if (v[key] !== undefined) out[key] = v[key]
  return out as Partial<T>
}

const CHECK_STATES = ['failure', 'pending', 'success', 'neutral', 'skipped']

function check(v: unknown): GhPrCheck | null {
  if (
    !record(v) ||
    !text(v.name, 200) ||
    !CHECK_STATES.includes(String(v.state)) ||
    !flag(v.required) ||
    !optional(v.title, (x) => text(x, 200))
  )
    return null
  return {
    name: v.name,
    state: v.state as GhPrCheck['state'],
    required: v.required,
    ...pick<GhPrCheck>(v, ['title']),
    ...link(v),
  }
}

function reviewer(v: unknown): GhPrReviewer | null {
  return record(v) && text(v.name, 200) && flag(v.team) && flag(v.codeOwner)
    ? { name: v.name, team: v.team, codeOwner: v.codeOwner }
    : null
}

function summary(v: unknown, key: GhPrKey): GhPrSummary | null {
  const base = parsePullRequest(v)
  if (!base || !record(v) || !isPrRef(v.ref) || prKey(v.ref) !== key) return null
  const checkRuns = v.checkRuns === null ? null : list(v.checkRuns, 200, check)
  const waitingOn = list(v.waitingOn, 100, reviewer)
  const threads = v.threads
  if (
    (v.checkRuns !== null && !checkRuns) ||
    !waitingOn ||
    !text(v.headRefName, 255) ||
    !text(v.baseRefName, 255) ||
    ![v.additions, v.deletions, v.changedFiles, v.comments].every(count) ||
    !text(v.updatedAt, 40) ||
    ![v.mergedAt, v.closedAt].every((at) => optional(at, (x) => text(x, 40))) ||
    !optional(v.author, (x) => text(x, 200)) ||
    !optional(v.headSha, (x) => text(x, 64)) ||
    ![v.checksTruncated, v.inMergeQueue, v.autoMerge].every(flag) ||
    !names(v.approvedBy) ||
    !names(v.changesRequestedBy) ||
    (threads !== null && (!record(threads) || !count(threads.total) || !count(threads.unresolved)))
  )
    return null
  const { host, owner, repo, number } = v.ref
  return {
    ...base,
    ref: { host, owner, repo, number },
    headRefName: v.headRefName,
    baseRefName: v.baseRefName,
    additions: v.additions as number,
    deletions: v.deletions as number,
    changedFiles: v.changedFiles as number,
    comments: v.comments as number,
    updatedAt: v.updatedAt,
    ...pick<GhPrSummary>(v, ['mergedAt', 'closedAt', 'author', 'headSha']),
    checkRuns,
    checksTruncated: v.checksTruncated as boolean,
    approvedBy: [...v.approvedBy],
    changesRequestedBy: [...v.changesRequestedBy],
    waitingOn,
    threads: record(threads)
      ? { total: threads.total as number, unresolved: threads.unresolved as number }
      : null,
    inMergeQueue: v.inMergeQueue as boolean,
    autoMerge: v.autoMerge as boolean,
  }
}

/** A Host's answer to `github.prSummaries` for `refs`; null when any part is out of shape. */
export function parsePrReadResult(v: unknown, refs: readonly GhPrRef[]): GhPrRead | null {
  if (!record(v) || !record(v.byKey) || !record(v.coverage)) return null
  const asked = new Set(refs.map(prKey))
  const byKey: Record<GhPrKey, GhPrSummary> = Object.create(null)
  const coverage: Record<GhPrKey, GhBranchCoverage> = Object.create(null)
  for (const [key, value] of Object.entries(v.byKey)) {
    const parsed = asked.has(key) ? summary(value, key) : null
    if (!parsed) return null
    byKey[key] = parsed
  }
  for (const [key, value] of Object.entries(v.coverage)) {
    const parsed = asked.has(key) ? parseCoverage(value) : null
    if (!parsed) return null
    coverage[key] = parsed
  }
  return { byKey, coverage }
}

function thread(v: unknown): GhPrThread | null {
  if (
    !record(v) ||
    !text(v.path, 4096) ||
    !optional(v.line, count) ||
    !flag(v.outdated) ||
    !optional(v.author, (x) => text(x, 200)) ||
    !text(v.body, 4096) ||
    !count(v.replies)
  )
    return null
  return {
    path: v.path,
    outdated: v.outdated,
    body: v.body,
    replies: v.replies,
    ...pick<GhPrThread>(v, ['line', 'author']),
    ...link(v),
  }
}

const LEVELS = ['failure', 'warning', 'notice']

function annotation(v: unknown): GhPrAnnotation | null {
  return record(v) &&
    text(v.path, 4096) &&
    optional(v.line, count) &&
    LEVELS.includes(String(v.level)) &&
    text(v.message, 4096)
    ? {
        path: v.path,
        level: v.level as GhPrAnnotation['level'],
        message: v.message,
        ...pick<GhPrAnnotation>(v, ['line']),
      }
    : null
}

function checkDetail(v: unknown): GhPrCheckDetail | null {
  const base = check(v)
  if (!base || !record(v)) return null
  const annotations = list(v.annotations, 10, annotation)
  if (
    !annotations ||
    ![v.workflow, v.startedAt, v.completedAt].every((x) => optional(x, (y) => text(y, 200)))
  )
    return null
  return {
    ...base,
    ...pick<GhPrCheckDetail>(v, ['workflow', 'startedAt', 'completedAt']),
    annotations,
  }
}

const EVENT_KINDS = [
  'review',
  'commit',
  'force-push',
  'requested',
  'ready',
  'merged',
  'closed',
  'reopened',
]

function event(v: unknown): GhPrEvent | null {
  return record(v) &&
    EVENT_KINDS.includes(String(v.kind)) &&
    text(v.at, 40) &&
    [v.actor, v.state, v.text].every((x) => optional(x, (y) => text(y, 500)))
    ? {
        kind: v.kind as GhPrEvent['kind'],
        at: v.at,
        ...pick<GhPrEvent>(v, ['actor', 'state', 'text']),
      }
    : null
}

/** A Host's answer to `github.prDetail` for `ref`; null when absent or out of shape. */
export function parsePrDetailResult(v: unknown, ref: GhPrRef): GhPrDetail | null {
  if (!record(v) || !isPrRef(v.ref) || prKey(v.ref) !== prKey(ref)) return null
  const threads = list(v.threads, 100, thread)
  const checks = v.checks === null ? null : list(v.checks, 200, checkDetail)
  const activity = list(v.activity, 50, event)
  if (
    !threads ||
    (v.checks !== null && !checks) ||
    !activity ||
    !flag(v.threadsTruncated) ||
    !flag(v.checksTruncated) ||
    !names(v.commented) ||
    !count(v.checkedAt)
  )
    return null
  const { host, owner, repo, number } = v.ref
  return {
    ref: { host, owner, repo, number },
    threads,
    threadsTruncated: v.threadsTruncated,
    checks,
    checksTruncated: v.checksTruncated,
    commented: [...v.commented],
    activity,
    checkedAt: v.checkedAt,
  }
}
