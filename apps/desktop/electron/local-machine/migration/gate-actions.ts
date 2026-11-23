import type { LocalMachineStatus } from '@phosphor/shared/ipc'
import type { LocalDaemonAccess } from '../mode'
import {
  newJournal,
  pastCommitPoint,
  readJournal,
  withState,
  type JournalWriter,
  type MigrationJournal,
  type MigrationPermit,
} from './journal'
import type { OwnerChannel } from './owner-channel'

/**
 * The two buttons on This Mac's runtime card that change the migration:
 * Retry (after the attempts ran out, or after a break-glass revert) and the
 * N12 consent to move a service that already runs lanes. Both take effect at
 * the next launch, which is the only place a migration ever starts.
 */

export interface ActionResult {
  readonly ok: boolean
  readonly message?: string
}

export interface GateActionPorts {
  readonly migrationDir: string
  readonly permit: MigrationPermit
  readonly access: LocalDaemonAccess | null
  readonly openChannel: (access: LocalDaemonAccess) => Promise<OwnerChannel | null>
  readonly runner: {
    readonly now: () => number
    readonly newId: () => string
    readonly desktopVersion: string
  }
  readonly writer: () => JournalWriter
  readonly published: (migration: LocalMachineStatus['migration']) => void
}

export const RESTART_TO_RETRY = 'Restart Phosphor to try moving this Mac’s lanes again.'
export const RESTART_TO_MOVE = 'Restart Phosphor to move this Mac’s lanes to the Phosphor service.'
const NOT_PERMITTED = 'This build does not move this Mac’s lanes.'

const current = (ports: GateActionPorts): MigrationJournal | null => {
  const read = readJournal(ports.migrationDir)
  return read.kind === 'ok' ? read.journal : null
}

/** Journals `retryRequested`, so the next launch tries again past the attempt limit or a revert. */
export function retryMigration(ports: GateActionPorts): Promise<ActionResult> {
  if (!ports.permit.allowed) return Promise.resolve({ ok: false, message: NOT_PERMITTED })
  const journal = current(ports)
  if (!journal || (journal.state !== 'aborted' && journal.state !== 'reverted'))
    return Promise.resolve({ ok: false, message: 'There is no failed move to retry.' })
  const at = new Date(ports.runner.now()).toISOString()
  ports.writer().write({ ...journal, retryRequested: true, updatedAt: at })
  ports.published('waiting')
  return Promise.resolve({ ok: true, message: RESTART_TO_RETRY })
}

/**
 * N12: journals `consented` (merging imports), then asks the service to stop
 * its lanes and release to standby (`machine.owner release`), surfacing its
 * refusal as it comes.
 */
export async function consentMigration(ports: GateActionPorts): Promise<ActionResult> {
  if (!ports.permit.allowed) return { ok: false, message: NOT_PERMITTED }
  if (!ports.access) return { ok: false, message: 'Phosphor cannot reach the Phosphor service.' }
  const previous = current(ports)
  if (previous && pastCommitPoint(previous.state))
    return { ok: false, message: 'This Mac already runs its lanes on the Phosphor service.' }
  const at = new Date(ports.runner.now()).toISOString()
  const base =
    previous ??
    newJournal({
      migrationId: ports.runner.newId(),
      desktopVersion: ports.runner.desktopVersion,
      at,
    })
  ports.writer().write(withState({ ...base, merge: true }, 'consented', at))
  const channel = await ports.openChannel(ports.access)
  if (!channel) return { ok: false, message: 'The Phosphor service did not answer.' }
  try {
    await channel.call('machine.owner', { action: 'release' })
    return { ok: true, message: RESTART_TO_MOVE }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    channel.close()
  }
}
