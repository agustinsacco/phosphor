/**
 * The Host's Brain admission while a handover can run (docs/brain-handover.md). The native Brain
 * runtime asks before it creates, opens or writes `<state>/brain`, on every entry point:
 *
 * - `open`: no move claimed the target. A fresh Host (Brain off) or a Brain this Host made.
 * - `handover`: a move holds the target, or published it but has not bound Brain Agent's
 *   conversation and committed. Nothing else may write there.
 * - `imported`: a committed move published the target; the runtime owns it now.
 * - `blocked`: a record is unreadable or contradicts another. Ownership is indeterminate, so
 *   nothing writes until someone repairs it; this never reads as `open`.
 */
import { readClaim, readHandover, readPublished } from './layout'
import { reconcile } from './publish'

export type HostBrainAdmission =
  | { readonly state: 'open' }
  | { readonly state: 'handover'; readonly migrationId: string }
  | { readonly state: 'imported'; readonly migrationId: string }
  | { readonly state: 'blocked'; readonly reason: string }

function admission(stateDir: string): HostBrainAdmission {
  const published = readPublished(stateDir)
  if (published) {
    const record = readHandover(stateDir, published.migrationId)
    if (!record) return { state: 'blocked', reason: 'A moved Brain has no handover record.' }
    if (record.state === 'committed') return { state: 'imported', migrationId: record.migrationId }
    if (record.state === 'aborted')
      return { state: 'blocked', reason: 'A moved Brain names an aborted handover.' }
    return { state: 'handover', migrationId: record.migrationId }
  }
  const claim = readClaim(stateDir)
  if (!claim) return { state: 'open' }
  const record = reconcile(stateDir, claim.migrationId, false)
  // A claim whose record never landed (a crash inside begin) still holds the target.
  if (!record || record.state !== 'aborted') {
    if (record?.state === 'committed')
      return { state: 'blocked', reason: 'A committed handover has no published Brain.' }
    return { state: 'handover', migrationId: claim.migrationId }
  }
  return { state: 'open' }
}

export function hostBrainAdmission(stateDir: string): HostBrainAdmission {
  try {
    return admission(stateDir)
  } catch {
    return { state: 'blocked', reason: 'A Brain handover record is unreadable.' }
  }
}

/**
 * The move fence alone: true only for `open` and `imported`. The native runtime's guard
 * (`brainOwnership` in `brain/run.ts`) also requires a local service's first-ownership grant.
 * Reads two small private files on each call; no cache, so a claim made after start fences the
 * very next call.
 */
export function hostBrainOwned(stateDir: string): boolean {
  const { state } = hostBrainAdmission(stateDir)
  return state === 'open' || state === 'imported'
}
