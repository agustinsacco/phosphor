import { isUuid } from './control-api'
import type { GhPullRequest, GhRepoPullRequests } from './models'

export const remotePrKey = (hostId: string, repositoryId: string): string =>
  `host:${hostId}/repo:${repositoryId}`
export function parseRemotePrKey(key: string): { hostId: string; repositoryId: string } | null {
  const match = /^host:([^/]+)\/repo:([a-f0-9]{16})$/.exec(key)
  return match && isUuid(match[1]) ? { hostId: match[1], repositoryId: match[2]! } : null
}
export function parsePrParams(value: unknown): string | null {
  if (!record(value) || Object.keys(value).length !== 1) return null
  return typeof value.repositoryId === 'string' && /^[a-f0-9]{16}$/.test(value.repositoryId)
    ? value.repositoryId
    : null
}
function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 4096
function parsePr(v: unknown): GhPullRequest | null {
  if (
    !record(v) ||
    !count(v.number) ||
    v.number === 0 ||
    !text(v.title) ||
    !text(v.url) ||
    !['OPEN', 'DRAFT', 'CLOSED', 'MERGED'].includes(String(v.state))
  )
    return null
  try {
    const url = new URL(v.url)
    if (url.protocol !== 'https:' || url.username || url.password) return null
  } catch {
    return null
  }
  if (v.mergeable !== undefined && !text(v.mergeable)) return null
  if (v.mergeStateStatus !== undefined && !text(v.mergeStateStatus)) return null
  if (
    v.reviewDecision !== undefined &&
    v.reviewDecision !== null &&
    v.reviewDecision !== '' &&
    !['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(String(v.reviewDecision))
  )
    return null
  const c = v.checks
  if (
    c !== undefined &&
    c !== null &&
    (!record(c) ||
      !count(c.passed) ||
      !count(c.failed) ||
      !count(c.pending) ||
      !count(c.total) ||
      c.total !== c.passed + c.failed + c.pending)
  )
    return null
  return {
    number: v.number,
    title: v.title,
    url: v.url,
    state: v.state as GhPullRequest['state'],
    ...(v.mergeable === undefined ? {} : { mergeable: v.mergeable as string }),
    ...(v.mergeStateStatus === undefined ? {} : { mergeStateStatus: v.mergeStateStatus as string }),
    ...(v.reviewDecision === undefined || v.reviewDecision === null || v.reviewDecision === ''
      ? {}
      : { reviewDecision: v.reviewDecision as GhPullRequest['reviewDecision'] }),
    ...(c === undefined
      ? {}
      : {
          checks:
            c === null
              ? null
              : {
                  passed: Number(c.passed),
                  failed: Number(c.failed),
                  pending: Number(c.pending),
                  total: Number(c.total),
                },
        }),
  }
}
export function parseRepoPrs(v: unknown): GhRepoPullRequests | null {
  if (!record(v) || !record(v.byBranch) || typeof v.complete !== 'boolean') return null
  const rows = Object.entries(v.byBranch)
  if (rows.length > 100) return null
  const byBranch: Record<string, GhPullRequest> = Object.create(null)
  for (const [branch, value] of rows) {
    const pr = parsePr(value)
    if (!branch || branch.length > 4096 || !pr) return null
    byBranch[branch] = pr
  }
  return { byBranch, complete: v.complete }
}
