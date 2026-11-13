import { parsePrUrl, prKey } from '@shared/github-pr-refs'
import type {
  GhPrDetail,
  GhPrRead,
  GhPrRef,
  GhPrSummary,
  LanePrSignals,
  SessionMeta,
} from '@shared/models'
import { applyLanePrOverride } from '../stores/lanePrOverrides'
import {
  blockedOnOwners,
  prCheck,
  prDetail,
  prRef,
  prSummary,
} from '../features/sessions/__fixtures__/pullRequests'

/**
 * The browser harness's pull requests, read by number. Lane `a` opened two
 * PRs from subagents (one red on an optional bot, one waiting on code owners),
 * reviewed a third and mentioned two more; lane `b` has one with checks running.
 */
export const MOCK_LANE_PRS: Record<string, LanePrSignals> = {
  a: {
    opened: [prRef(57), prRef(58)],
    branches: [],
    reviewing: [prRef(55)],
    mentioned: [prRef(61), prRef(39)],
    pinned: [],
    hidden: [],
  },
  b: {
    opened: [prRef(63)],
    branches: [],
    reviewing: [],
    mentioned: [],
    pinned: [],
    hidden: [],
  },
}

const SUMMARIES: Record<number, () => GhPrSummary> = {
  57: () => prSummary(),
  58: () => blockedOnOwners(58),
  55: () =>
    prSummary({
      ref: prRef(55),
      number: 55,
      title: 'Fix the composer losing its draft on lane switch',
      author: 'mara',
      headRefName: 'mara/draft-switch',
      checks: { passed: 6, failed: 0, pending: 0, total: 6 },
      checkRuns: [prCheck('build', 'success', true), prCheck('unit', 'success', true)],
      approvedBy: [],
      waitingOn: [{ name: 'agustinsacco', team: false, codeOwner: false }],
      threads: { total: 2, unresolved: 1 },
    }),
  61: () =>
    prSummary({
      ref: prRef(61),
      number: 61,
      title: 'Notification drawer: group receipts by lane',
      state: 'DRAFT',
      checks: { passed: 2, failed: 0, pending: 3, total: 5 },
      checkRuns: [
        prCheck('build', 'success', true),
        prCheck('unit', 'pending', true),
        prCheck('e2e (ubuntu)', 'pending', true),
      ],
      approvedBy: [],
      waitingOn: [],
      threads: { total: 0, unresolved: 0 },
    }),
  39: () =>
    prSummary({
      ref: prRef(39),
      number: 39,
      title: 'Lane loop removal',
      state: 'MERGED',
      mergedAt: '2026-11-08T12:00:00Z',
      checks: { passed: 4, failed: 0, pending: 0, total: 4 },
      checkRuns: [prCheck('build', 'success', true)],
      reviewDecision: 'APPROVED',
      threads: { total: 3, unresolved: 0 },
    }),
  63: () =>
    prSummary({
      ref: prRef(63),
      number: 63,
      title: 'Speed up the vite build with a warm cache',
      headRefName: 'agustin/vite-cache',
      checks: { passed: 3, failed: 0, pending: 3, total: 6 },
      checkRuns: [
        prCheck('build', 'success', true),
        prCheck('lint', 'success', true),
        prCheck('unit', 'pending', true),
        prCheck('e2e (ubuntu)', 'pending', true),
        prCheck('e2e (macos)', 'pending', true),
      ],
      approvedBy: [],
      threads: { total: 0, unresolved: 0 },
    }),
}

const summaryFor = (ref: GhPrRef): GhPrSummary => {
  const make = SUMMARIES[ref.number]
  return make
    ? { ...make(), ref: { ...ref } }
    : prSummary({ ref: { ...ref }, number: ref.number, title: `Pull request #${ref.number}` })
}

export function mockPrSummaries(refs: GhPrRef[]): Promise<GhPrRead> {
  const now = Date.now()
  const read: GhPrRead = { byKey: {}, coverage: {} }
  for (const ref of refs) {
    read.byKey[prKey(ref)] = summaryFor(ref)
    read.coverage[prKey(ref)] = { state: 'found', checkedAt: now, attemptedAt: now }
  }
  return Promise.resolve(read)
}

export function mockPrDetail(ref: GhPrRef): Promise<GhPrDetail> {
  const base = prDetail({ ref: { ...ref }, checkedAt: Date.now() })
  if (ref.number === 57) return Promise.resolve(base)
  const summary = summaryFor(ref)
  return Promise.resolve({
    ...base,
    threads: base.threads.slice(0, summary.threads?.unresolved ?? 0),
    checks: (summary.checkRuns ?? []).map((c) => ({ ...c, workflow: 'Checks', annotations: [] })),
    commented: [],
  })
}

const LANE_PRS_PROMPT = /^\/phosphor-prs (pin|hide|clear) (\S+)$/

/**
 * `/phosphor-prs` in the harness, sent to the lane opened from `path`: pi
 * would append the entry, and the next scan would fold it into the lane's
 * PRs. Returns false for any other prompt.
 */
export function mockLanePrOverride(
  sessions: SessionMeta[],
  path: string | undefined,
  message: string,
): boolean {
  const match = LANE_PRS_PROMPT.exec(message)
  if (!match) return false
  const ref = parsePrUrl(match[2]!)
  const index = sessions.findIndex((meta) => meta.path === path)
  const meta = sessions[index]
  if (!ref || !meta) return true
  const action = match[1] as 'pin' | 'hide' | 'clear'
  const pullRequests = applyLanePrOverride(meta.pullRequests, action, ref)
  sessions[index] = { ...meta, pullRequests }
  MOCK_LANE_PRS[meta.sessionId] = pullRequests
  return true
}
