import type { UpdateRun } from './machineUpdateState'

/**
 * A handoff that stays connected on its old version this long could not apply; a
 * restart that is still away this long says so, since a failed one may be rolling back.
 */
export const RESTART_SLOW_MS = 4 * 60_000
/** The updater's 180 s health wait, its rollback restart and a slow old start fit in this. */
export const RESTART_DEADLINE_MS = 6 * 60_000
/** A wait whose pause names no usable cap gives up after this. */
const WAIT_FALLBACK_MS = 30 * 60_000

export function restartedFor(run: UpdateRun, now: number, ms: number): boolean {
  return run.restartAt !== undefined && now - run.restartAt >= ms
}

/** The Host's own cap on the wait (`deadline` − `since`, both its clock), from when this client saw it. */
export function waitEnded(run: UpdateRun, now: number): boolean {
  if (run.reached !== 'waiting' || !run.waiting || run.waitingSince === undefined) return false
  const cap = Date.parse(run.waiting.deadline) - Date.parse(run.waiting.since)
  return now - run.waitingSince >= (Number.isFinite(cap) && cap > 0 ? cap : WAIT_FALLBACK_MS)
}
