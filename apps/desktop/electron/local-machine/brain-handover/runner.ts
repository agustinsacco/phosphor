/**
 * Moving This Mac's Desktop Brain to its local Phosphor service, once, at launch and before
 * Brain starts (docs/brain-handover.md). Each step is recorded before it runs, so a crash or a
 * lost answer resumes by migration id and asks the service which side committed:
 *
 * 1. `fenced`: Desktop's Brain refuses to open; the service claims its empty target, the owner
 *    stages a consistent copy and the service verifies sealed copies of it.
 * 2. `tombstoned`: the original keeps a second name and a tombstone takes the legacy path,
 *    so no Desktop build can write; then the service publishes.
 * 3. `committed`: the service owns the Brain. Desktop never serves the pre-move copy again.
 *
 * A refusal before publication aborts both sides and returns the untouched original to Desktop.
 */
import { randomUUID } from 'node:crypto'
import { OwnerCallError } from '@phosphor/host-client/owner'
import type {
  BrainHandoverState,
  OwnerCalls,
  OwnerMethod,
} from '@phosphor/shared/host-protocol-owner'
import {
  brainHandoverPaths,
  isBrainTombstoneFile,
  readBrainHandoverRecord,
  writeBrainHandoverRecord,
  type DesktopBrainHandoverPhase,
} from '../../brain/owner-gate'
import {
  brainSourceIdentity,
  desktopModelPresent,
  stageDesktopBrain,
  type DesktopBrainSources,
} from './stage'
import { installBrainTombstone, restoreBrainOriginal } from './tombstone'

export interface BrainHandoverChannel {
  call<M extends OwnerMethod>(
    method: M,
    params: OwnerCalls[M]['params'],
  ): Promise<OwnerCalls[M]['result']>
}

export interface BrainHandoverRunPorts {
  readonly userData: string
  readonly desktopVersion: string
  readonly beforeHostOwnership?: () => Promise<void>
  readonly sources: DesktopBrainSources
  readonly newId?: () => string
  /** Waits between checks on a verification that outlived the call deadline. */
  readonly wait?: (ms: number) => Promise<void>
  readonly log?: (event: string, fields?: Record<string, unknown>) => void
}

/**
 * `none`: nothing to move. `deferred`: the service cannot take it now. `pending`: an earlier
 * move's outcome is unknown, so Brain stays fenced. `aborted`: Desktop keeps its Brain.
 */
export type BrainHandoverOutcome = 'none' | 'deferred' | 'pending' | 'aborted' | 'moved'

const PUBLISHED: readonly BrainHandoverState[] = ['published', 'committed']
/** How long a long verification may keep running after its call timed out. */
export const VERIFY_PATIENCE = { checks: 300, everyMs: 2_000 } as const

/**
 * Verification can outlive the 30 s call deadline on a large Brain; the service still finishes
 * it. A refusal is final; a deadline is followed by checks until the move reads `verified`.
 */
async function verified(
  ports: BrainHandoverRunPorts,
  channel: BrainHandoverChannel,
  migrationId: string,
  staged: Omit<OwnerCalls['owner.brainHandover.verify']['params'], 'migrationId'>,
): Promise<void> {
  try {
    await channel.call('owner.brainHandover.verify', { migrationId, ...staged })
    return
  } catch (error) {
    if (!(error instanceof OwnerCallError) || error.code !== 'internal') throw error
  }
  const wait = ports.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  for (let check = 0; check < VERIFY_PATIENCE.checks; check++) {
    await wait(VERIFY_PATIENCE.everyMs)
    const { state } = await channel.call('owner.brainHandover.status', { migrationId })
    if (state === 'verified') return
    if (state !== 'staged') break
  }
  throw new Error('The Phosphor service did not verify the Brain in time.')
}

function record(
  ports: BrainHandoverRunPorts,
  migrationId: string,
  phase: DesktopBrainHandoverPhase,
) {
  writeBrainHandoverRecord(ports.userData, { version: 1, migrationId, phase })
}

/** Both sides back to before the move; only once the service said it never published. */
async function abortBoth(
  ports: BrainHandoverRunPorts,
  channel: BrainHandoverChannel,
  migrationId: string,
): Promise<'aborted'> {
  await channel.call('owner.brainHandover.abort', { migrationId })
  restoreBrainOriginal(ports.userData, migrationId)
  record(ports, migrationId, 'aborted')
  ports.log?.('brain handover aborted', { migrationId })
  return 'aborted'
}

async function commit(
  ports: BrainHandoverRunPorts,
  channel: BrainHandoverChannel,
  migrationId: string,
): Promise<BrainHandoverOutcome> {
  await ports.beforeHostOwnership?.()
  await channel.call('owner.brainHandover.commit', { migrationId })
  record(ports, migrationId, 'committed')
  ports.log?.('brain handover committed', { migrationId })
  return 'moved'
}

/**
 * Settles a move an earlier launch left unfinished. Without a channel, or when the service
 * cannot say, the move stays pending: Desktop never guesses who owns the Brain.
 */
export async function resolveBrainHandover(
  ports: BrainHandoverRunPorts,
  channel: BrainHandoverChannel | null,
): Promise<BrainHandoverOutcome | null> {
  const current = readBrainHandoverRecord(ports.userData)
  if (!current || current.phase === 'aborted') return null
  if (current.phase === 'committed') return 'moved'
  if (!channel) return 'pending'
  const { migrationId } = current
  let state: BrainHandoverState
  try {
    state = (await channel.call('owner.brainHandover.status', { migrationId })).state
  } catch {
    return 'pending'
  }
  if (PUBLISHED.includes(state)) {
    if (current.phase !== 'tombstoned') return 'pending'
    return await commit(ports, channel, migrationId).catch(() => 'pending' as const)
  }
  // A recorded tombstone that never landed: an older build may have written the original since
  // it was verified. Nothing published yet, so the move aborts and Desktop keeps its Brain.
  const tombstoned = isBrainTombstoneFile(brainHandoverPaths(ports.userData).legacy)
  if (current.phase === 'tombstoned' && state === 'verified' && tombstoned)
    return await commit(ports, channel, migrationId).catch(async (error: unknown) =>
      // The service refused to publish (its target filled up): nothing moved, so abort.
      error instanceof OwnerCallError && error.code === 'forbidden'
        ? await abortBoth(ports, channel, migrationId).catch(() => 'pending' as const)
        : ('pending' as const),
    )
  return await abortBoth(ports, channel, migrationId).catch(() => 'pending' as const)
}

async function startMove(
  ports: BrainHandoverRunPorts,
  channel: BrainHandoverChannel,
): Promise<BrainHandoverOutcome> {
  const source = brainSourceIdentity(ports.sources)
  if (!source) return 'none'
  if (source.schema !== 7 && source.schema !== 8) return 'deferred'
  // Before fencing: a move without a model on this Mac could only fail at the service.
  if (!(await desktopModelPresent(ports.sources))) return 'deferred'
  const { support } = await channel.call('owner.brainHandover.status', {})
  if (!support.handover || support.reader !== 'qualified' || support.target !== 'empty')
    return 'deferred'
  const migrationId = (ports.newId ?? randomUUID)()
  record(ports, migrationId, 'fenced')
  ports.log?.('brain handover started', { migrationId })
  try {
    const { staging } = await channel.call('owner.brainHandover.begin', {
      migrationId,
      sourceSchema: source.schema,
      sourceGeneration: source.generation,
      desktopVersion: ports.desktopVersion,
    })
    const staged = await stageDesktopBrain(ports.sources, staging)
    await verified(ports, channel, migrationId, staged)
    await ports.beforeHostOwnership?.()
    record(ports, migrationId, 'tombstoned')
    installBrainTombstone(ports.userData, migrationId, ports.sources.sqlite.DatabaseSync)
  } catch (error) {
    ports.log?.('brain handover refused', { migrationId, error: String(error) })
    return await abortBoth(ports, channel, migrationId).catch(() => 'pending' as const)
  }
  try {
    return await commit(ports, channel, migrationId)
  } catch (error) {
    ports.log?.('brain handover commit unanswered', { migrationId, error: String(error) })
    // Refused or lost: ask which side committed rather than assume.
    return (await resolveBrainHandover(ports, channel)) ?? 'aborted'
  }
}

/** At launch, before Brain starts: settle an unfinished move, then start one if it is time. */
export async function runBrainHandover(
  ports: BrainHandoverRunPorts,
  channel: BrainHandoverChannel,
): Promise<BrainHandoverOutcome> {
  const resolved = await resolveBrainHandover(ports, channel)
  // An earlier move that just aborted waits for the next launch rather than retrying at once.
  if (resolved) return resolved
  try {
    return await startMove(ports, channel)
  } catch (error) {
    ports.log?.('brain handover deferred', { error: String(error) })
    return 'deferred'
  }
}
