import type { LocalMachineStatus } from '@phosphor/shared/ipc'
import { POST_COMMIT_STEPS, stepDone, type JournalRead, type MigrationJournal } from './journal'

/**
 * The launch decision table (D1 §3.6 with the lead's wave-8 rows), pure.
 * Authority order: the journal past its commit point, then the owner lock,
 * then the rest. It runs before any connection: rows that need the service
 * answer `probe`, and the gate asks the service, time-bounded, before it
 * decides the mode once.
 */

/** Read-only: absent, stale or Desktop's own lock are one row (`free`). */
export type LockFact = 'free' | 'daemon'

export interface LaunchFacts {
  /** `migrationPermit(...)`: packaged, or unpackaged with both flags. */
  readonly permitted: boolean
  readonly journal: JournalRead
  readonly lock: LockFact
  /** Desktop installed the service and recorded both features (or the gated e2e override). */
  readonly recorded: boolean
  /** In-app data a migration would move: recents, pins or a last session. */
  readonly legacyKeys: boolean
  /** `prefs.localRuntime`: an earlier launch finished a migration. */
  readonly localRuntime: boolean
  /** This process knows where its service is (packaged install roots, or the e2e hook). */
  readonly reachable: boolean
  readonly packaged: boolean
  /** E1's gated hook: an unpackaged run pointed at a fixture service. */
  readonly e2eDaemon: boolean
  /** Automatic attempts already made by this Desktop version. */
  readonly attempts: number
}

export const MAX_ATTEMPTS = 3

export type LaunchPlan =
  | { readonly kind: 'in-app'; readonly status: LocalMachineStatus }
  | { readonly kind: 'daemon'; readonly status: LocalMachineStatus }
  /** Ask the service: roll a commit forward, then daemon mode, never in-app. */
  | { readonly kind: 'resume'; readonly journal: MigrationJournal }
  /** Ask the service: abort a staged attempt if any, then migrate if it is ready. */
  | { readonly kind: 'migrate'; readonly previous: MigrationJournal | null }

const inApp = (status: Omit<LocalMachineStatus, 'mode'>): LaunchPlan => ({
  kind: 'in-app',
  status: { mode: 'in-app', ...status },
})
const daemon = (status: Omit<LocalMachineStatus, 'mode'>): LaunchPlan => ({
  kind: 'daemon',
  status: { mode: 'daemon', ...status },
})

/** Every post-commit step and `done` finished: nothing is left to replay. */
export function migrationFinished(journal: MigrationJournal): boolean {
  return (
    journal.state === 'committed' &&
    POST_COMMIT_STEPS.every((step) => stepDone(journal, step)) &&
    stepDone(journal, 'done')
  )
}

/** Daemon mode with no way to reach the service: its down state, never in-app. */
const unreachable = (facts: LaunchFacts, status: Omit<LocalMachineStatus, 'mode'>) =>
  daemon({ ...status, service: 'down', ...(facts.packaged ? {} : { notice: 'dev-build' }) })

function pastCommit(facts: LaunchFacts, journal: MigrationJournal): LaunchPlan {
  if (!facts.reachable) return unreachable(facts, { migration: 'committed' })
  if (migrationFinished(journal)) return daemon({ migration: 'committed' })
  return { kind: 'resume', journal }
}

/** The service runs lanes Desktop did not hand it (N12), or Desktop's own finished one. */
function liveService(facts: LaunchFacts): LaunchPlan {
  if (facts.legacyKeys) return inApp({ migration: 'consent-needed', notice: 'other-daemon' })
  if ((facts.recorded || facts.localRuntime) && facts.reachable)
    return daemon({ migration: 'not-needed' })
  return inApp({ migration: 'not-needed', notice: 'other-daemon' })
}

export function decideLaunch(facts: LaunchFacts): LaunchPlan {
  const read = facts.journal
  const journal = read.kind === 'ok' ? read.journal : null
  if (read.kind === 'unreadable') {
    // Never "no journal": a commit may lie behind it.
    const failed = {
      migration: 'failed' as const,
      failure: { step: 'preflight', code: 'journal-unreadable' },
    }
    if (facts.recorded || facts.localRuntime || facts.lock === 'daemon')
      return facts.reachable ? daemon(failed) : unreachable(facts, failed)
    return inApp(failed)
  }
  if (journal && (journal.state === 'commit-requested' || journal.state === 'committed'))
    return pastCommit(facts, journal)
  if (facts.e2eDaemon && !facts.permitted) return daemon({ migration: 'not-needed' })
  if (facts.lock === 'daemon') return liveService(facts)
  if (journal?.state === 'reverted' && !journal.retryRequested)
    return inApp({ migration: 'reverted' })
  if (!facts.permitted || !facts.reachable || !facts.recorded)
    return inApp({ migration: 'not-needed' })
  if (facts.attempts >= MAX_ATTEMPTS && !journal?.retryRequested)
    return inApp({
      migration: 'failed',
      ...(journal?.failure ? { failure: journal.failure } : {}),
    })
  return { kind: 'migrate', previous: journal }
}
