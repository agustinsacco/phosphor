import type { GhPrCheck, GhPrCheckDetail, GhPrDetail, GhPrSummary } from '@shared/models'

/**
 * The order the inspector lists a PR's checks in: what needs you first.
 * Failing, then running, then required passing; the rest fold behind
 * "+N passing", and skipped checks collapse into one line.
 */
export type InspectorCheck = GhPrCheck & Partial<Omit<GhPrCheckDetail, keyof GhPrCheck>>

export interface CheckCounts {
  passed: number
  failed: number
  pending: number
  neutral: number
  skipped: number
  total: number
}

export interface CheckGroups {
  /** null: GitHub could not list them. Nothing may read as passing. */
  known: boolean
  /** More than 100 contexts: the list and counts are partial. */
  truncated: boolean
  /** Failing, running, then required passing. */
  lead: InspectorCheck[]
  /** Optional passing and neutral checks, behind "+N passing". */
  rest: InspectorCheck[]
  skipped: InspectorCheck[]
  counts: CheckCounts
}

const RANK: Record<GhPrCheck['state'], number> = {
  failure: 0,
  pending: 1,
  success: 2,
  neutral: 3,
  skipped: 4,
}

/** Detail's checks when read, else the summary's runs. */
export function inspectorChecks(
  summary: GhPrSummary | undefined,
  detail: GhPrDetail | undefined,
): { checks: InspectorCheck[] | null; truncated: boolean } {
  if (detail?.checks) return { checks: detail.checks, truncated: detail.checksTruncated }
  return {
    checks: summary?.checkRuns ?? null,
    truncated: !!summary?.checksTruncated || !!detail?.checksTruncated,
  }
}

export function countChecks(checks: InspectorCheck[]): CheckCounts {
  const counts: CheckCounts = { passed: 0, failed: 0, pending: 0, neutral: 0, skipped: 0, total: 0 }
  for (const check of checks) {
    counts.total += 1
    if (check.state === 'success') counts.passed += 1
    else if (check.state === 'failure') counts.failed += 1
    else if (check.state === 'pending') counts.pending += 1
    else if (check.state === 'neutral') counts.neutral += 1
    else counts.skipped += 1
  }
  return counts
}

const isLead = (check: InspectorCheck) =>
  check.state === 'failure' ||
  check.state === 'pending' ||
  (check.state === 'success' && check.required)

export function groupChecks(checks: InspectorCheck[] | null, truncated = false): CheckGroups {
  const list = [...(checks ?? [])]
    .map((check, index) => ({ check, index }))
    .sort(
      (a, b) =>
        RANK[a.check.state] - RANK[b.check.state] ||
        Number(b.check.required) - Number(a.check.required) ||
        a.index - b.index,
    )
    .map(({ check }) => check)
  return {
    known: checks !== null,
    truncated,
    lead: list.filter(isLead),
    rest: list.filter((c) => !isLead(c) && c.state !== 'skipped'),
    skipped: list.filter((c) => c.state === 'skipped'),
    counts: countChecks(list),
  }
}

/** `1m 27s`, or how long a running check has run so far. Absent without a start. */
export function checkDuration(check: InspectorCheck, now: number): string | undefined {
  const start = check.startedAt ? Date.parse(check.startedAt) : NaN
  if (Number.isNaN(start)) return undefined
  const end = check.completedAt ? Date.parse(check.completedAt) : now
  if (Number.isNaN(end) || end < start) return undefined
  const seconds = Math.round((end - start) / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Why a check says what it says: its first annotation, else its own summary line. */
export function checkNote(check: InspectorCheck): string | undefined {
  const annotation = check.annotations?.[0]
  if (annotation)
    return `${annotation.message}${annotation.path ? ` (${annotation.path}${annotation.line ? `:${annotation.line}` : ''})` : ''}`
  return check.title
}
