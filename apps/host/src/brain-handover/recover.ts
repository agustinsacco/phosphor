/**
 * What a Host restart settles on its own (docs/brain-handover.md, Recovery). Desktop calls
 * `commit` only after its tombstone is in place, so a Brain this Host published is already the
 * Host's. A restart therefore finishes that commit without Desktop, but only when the published
 * marker, the move's durable record and its sealed manifest all agree. A verified move that never
 * published stays verified: only Desktop's `commit` publishes. A settled move's redundant private
 * copies go; Desktop's original never lives here and an unfinished move keeps everything.
 */
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isUuid } from '@phosphor/shared/control-api'
import { parseOwnerParams } from '@phosphor/shared/host-protocol-owner'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { BrainAgentTranscriptImporter } from './handlers'
import {
  handoverPaths,
  readClaim,
  readHandover,
  readPublished,
  writeRecord,
  type HandoverRecord,
  type PublishedMarker,
} from './layout'
import type { BrainHandoverNativePorts } from './owner-seam'
import { completePublished, dropPrivateCopies, sha256 } from './publish'

export interface BrainHandoverRecoveryPorts {
  readonly stateDir: string
  /** The reserved lane's importer; without one a published move waits for a Host that has it. */
  readonly importAgentTranscripts?: BrainAgentTranscriptImporter
  readonly log?: (event: string, fields?: Record<string, unknown>) => void
}

function regularFile(path: string): boolean {
  try {
    const info = lstatSync(path)
    return info.isFile() && info.nlink === 1
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return false
    throw error
  }
}

/** Why a published move cannot be finished here, or null when marker, record and seal agree. */
async function mismatch(
  stateDir: string,
  marker: PublishedMarker,
  record: HandoverRecord | null,
): Promise<string | null> {
  if (!record) return 'no-record'
  if (record.sourceGeneration !== marker.sourceGeneration) return 'generation'
  if (record.state !== 'verified' && record.state !== 'published') return 'state'
  const claim = readClaim(stateDir)
  if (claim && claim.migrationId !== record.migrationId) return 'claim'
  const sealed = record.sealed ?? []
  if (!record.report || record.active === undefined || !sealed.length) return 'seal'
  const files = sealed.map(({ path, bytes, sha256 }) => ({
    name: path === 'brain/Brain/AGENTS.md' ? 'AGENTS.md' : path.replace(/^brain\//, ''),
    bytes,
    sha256,
  }))
  if (
    !parseOwnerParams('owner.brainHandover.begin', record) ||
    !parseOwnerParams('owner.brainHandover.verify', {
      migrationId: record.migrationId,
      files,
      activeTranscript: record.active === null ? null : `transcripts/${record.active}`,
    }) ||
    !sealed.some((file) => file.path === 'brain/brain.sqlite')
  )
    return 'seal'
  const paths = handoverPaths(stateDir, record.migrationId)
  for (const file of sealed) {
    const brain = file.path.startsWith('brain/')
    const path = brain
      ? join(paths.target, file.path.slice('brain/'.length))
      : join(paths.sealed, file.path)
    if (!regularFile(path)) return 'seal'
    if ((await sha256(path)) !== file.sha256) return 'seal'
  }
  return null
}

/** Commits the move the marker names when its record and seal match; otherwise leaves it. */
async function rollForward(ports: BrainHandoverRecoveryPorts): Promise<void> {
  const { stateDir, log } = ports
  const marker = readPublished(stateDir)
  if (!marker || !isUuid(marker.migrationId)) return
  const record = readHandover(stateDir, marker.migrationId)
  if (record?.state === 'committed') return
  const migrationId = marker.migrationId
  const reason = await mismatch(stateDir, marker, record)
  if (reason || !record) {
    log?.('brain.handover.recovery-held', { migrationId, reason })
    return
  }
  const importer = ports.importAgentTranscripts
  if (!importer) {
    log?.('brain.handover.recovery-held', { migrationId, reason: 'importer' })
    return
  }
  const published: HandoverRecord = { ...record, state: 'published' }
  if (record.state !== 'published')
    writeRecord(handoverPaths(stateDir, migrationId).record, published)
  await completePublished(stateDir, published, importer)
  log?.('brain.handover.committed', { migrationId, recovered: true })
}

/** Drops redundant private copies of committed and aborted moves; skips anything unreadable. */
async function sweepSettled(ports: BrainHandoverRecoveryPorts): Promise<void> {
  const { root } = handoverPaths(ports.stateDir)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return
    throw error
  }
  for (const migrationId of names.filter(isUuid)) {
    let state: HandoverRecord['state'] | undefined
    try {
      state = readHandover(ports.stateDir, migrationId)?.state
    } catch {
      continue
    }
    if (state === 'committed' || state === 'aborted')
      await dropPrivateCopies(ports.stateDir, migrationId)
  }
}

/**
 * Failures are logged: the move stays as it was, fenced, for Desktop's next `commit` or the next
 * restart.
 */
export async function recoverBrainHandover(ports: BrainHandoverRecoveryPorts): Promise<void> {
  try {
    await rollForward(ports)
  } catch {
    ports.log?.('brain.handover.recovery-failed')
  }
  try {
    await sweepSettled(ports)
  } catch {
    ports.log?.('brain.handover.sweep-failed')
  }
}

/**
 * At Host start: settle what the last run left, then hand the owner socket the native ports, so
 * Desktop's `commit` never races the restart's own.
 */
export async function settleBrainHandover(
  stateDir: string,
  native: Required<BrainHandoverNativePorts> | undefined,
  slot: { current?: BrainHandoverNativePorts } | undefined,
  log: { readonly write: RuntimeLog },
): Promise<void> {
  await recoverBrainHandover({
    stateDir,
    importAgentTranscripts: native?.importAgentTranscripts,
    log: (event, fields) => log.write('host', event, fields),
  })
  if (slot) slot.current = native
}
