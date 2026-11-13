import { isPrRef, parsePrRefs, parsePrSummaryOptions, prKey } from './github-pr-refs'
import { isLaneBranchName } from './host-protocol/primitives'
import type { GhPrRef, GhPrSummaryOptions, LanePrSignals } from './models'

/**
 * Lane PR signals on a Host's `LaneSummary`, and the params of
 * `github.prSummaries` / `github.prDetail`. A lanes frame carries every lane's
 * signals, so the wire keeps fewer than the fold does: a lane's first PRs it
 * opened, pushed, reviewed or mentioned, and its latest pins and hides.
 */
/** Read by number on the Host's own gh, under `workspaces.read`, like `github.prs`. */
export const PR_STATUS_METHODS = ['github.prSummaries', 'github.prDetail'] as const

export const LANE_PR_WIRE_LIMITS = {
  opened: 20,
  branches: 20,
  reviewing: 10,
  reviewingHere: 10,
  mentioned: 10,
  pinned: 20,
  hidden: 20,
} as const

/** Trim a lane's folded signals to what one lane summary may carry. */
export function laneSignalsForWire(signals: LanePrSignals): LanePrSignals {
  const L = LANE_PR_WIRE_LIMITS
  return {
    opened: signals.opened.slice(0, L.opened),
    branches: signals.branches.filter(isLaneBranchName).slice(0, L.branches),
    reviewing: signals.reviewing.slice(0, L.reviewing),
    ...(signals.reviewingHere?.length
      ? { reviewingHere: signals.reviewingHere.slice(0, L.reviewingHere) }
      : {}),
    mentioned: signals.mentioned.slice(0, L.mentioned),
    // Overrides are kept in the order they were last set: the latest win.
    pinned: signals.pinned.slice(-L.pinned),
    hidden: signals.hidden.slice(-L.hidden),
  }
}

function refs(v: unknown, max: number): GhPrRef[] | null {
  if (!Array.isArray(v) || v.length > max || !v.every(isPrRef)) return null
  if (new Set(v.map(prKey)).size !== v.length) return null
  return v.map((ref) => ({ host: ref.host, owner: ref.owner, repo: ref.repo, number: ref.number }))
}

/** A lane summary's `pullRequests`, or null when any part is out of shape. */
export function parseLanePrSignals(v: unknown): LanePrSignals | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const s = v as Record<string, unknown>
  const L = LANE_PR_WIRE_LIMITS
  const opened = refs(s.opened, L.opened)
  const reviewing = refs(s.reviewing, L.reviewing)
  const mentioned = refs(s.mentioned, L.mentioned)
  const pinned = refs(s.pinned, L.pinned)
  const hidden = refs(s.hidden, L.hidden)
  const branches = s.branches
  const here = s.reviewingHere
  if (
    !opened ||
    !reviewing ||
    !mentioned ||
    !pinned ||
    !hidden ||
    !Array.isArray(branches) ||
    branches.length > L.branches ||
    !branches.every(isLaneBranchName) ||
    (here !== undefined &&
      (!Array.isArray(here) ||
        here.length > L.reviewingHere ||
        !here.every((n) => Number.isSafeInteger(n) && (n as number) > 0)))
  )
    return null
  return {
    opened,
    branches: [...(branches as string[])],
    reviewing,
    ...(Array.isArray(here) && here.length ? { reviewingHere: [...(here as number[])] } : {}),
    mentioned,
    pinned,
    hidden,
  }
}

/** The `machine` argument of `gh:prSummaries` / `gh:prDetail` that reads through a Host. */
export const prStatusMachine = (hostId: string): string => `host:${hostId}`

/** The Host a `machine` argument names, or null for anything else. */
export function hostOfPrStatusMachine(machine: unknown): string | null {
  const match = typeof machine === 'string' ? /^host:([0-9a-f-]{36})$/i.exec(machine) : null
  return match ? match[1]! : null
}

function exact(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).every((key) => keys.includes(key))
  )
}

/** `github.prSummaries` params: `{ refs, options? }`, the same bounds as `gh:prSummaries`. */
export function parsePrSummariesParams(
  v: unknown,
): { refs: GhPrRef[]; options: GhPrSummaryOptions } | null {
  if (!exact(v, ['refs', 'options'])) return null
  const parsed = parsePrRefs(v.refs)
  const options = parsePrSummaryOptions(v.options)
  return parsed && parsed.length && options ? { refs: parsed, options } : null
}

/** `github.prDetail` params: `{ ref, options? }`. */
export function parsePrDetailParams(
  v: unknown,
): { ref: GhPrRef; options: GhPrSummaryOptions } | null {
  if (!exact(v, ['ref', 'options']) || !isPrRef(v.ref)) return null
  const options = parsePrSummaryOptions(v.options)
  const { host, owner, repo, number } = v.ref
  return options ? { ref: { host, owner, repo, number }, options } : null
}
