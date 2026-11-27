/**
 * Publishing a verified Brain, and every answer about who owns it. The ownership marker is
 * written into the sealed copy before one rename makes it the Host's Brain, so a crash leaves
 * either the move unpublished or the marker in place; `reconcile` reads that, never a guess from
 * an empty folder. Nothing replaces a target that already holds anything.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isUuid } from '@phosphor/shared/control-api'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import type { BrainAgentTranscriptImporter } from './handlers'
import {
  handoverPaths,
  readClaim,
  readHandover,
  readPublished,
  syncDirectory,
  targetOccupied,
  writeRecord,
  type HandoverRecord,
  type PublishedMarker,
} from './layout'

export class PublishRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishRefused'
  }
}

/**
 * Reads one move's record, rolled forward when its marker shows the rename happened. `persist`
 * writes the roll-forward; a read-only caller (status, the gate) leaves that to the next mutation.
 */
export function reconcile(
  stateDir: string,
  migrationId: string,
  persist = true,
): HandoverRecord | null {
  const record = readHandover(stateDir, migrationId)
  if (!record) return null
  const published = readPublished(stateDir)
  if (
    published?.migrationId === migrationId &&
    (record.state === 'verified' || record.state === 'staged')
  ) {
    const next: HandoverRecord = { ...record, state: 'published' }
    if (persist) writeRecord(handoverPaths(stateDir, migrationId).record, next)
    return next
  }
  return record
}

export async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Checks the sealed Brain files are still the verified bytes, marks them as this move's and
 * renames them into place. Returns the published record.
 */
export async function publishSealed(
  stateDir: string,
  record: HandoverRecord,
): Promise<HandoverRecord> {
  const paths = handoverPaths(stateDir, record.migrationId)
  const brain = (record.sealed ?? []).filter((file) => file.path.startsWith('brain/'))
  for (const file of brain) {
    const path = join(paths.sealed, file.path)
    if ((await sha256(path)) !== file.sha256)
      throw new PublishRefused('The sealed Brain changed after it was verified.')
    await chmod(path, 0o600)
  }
  if (targetOccupied(stateDir))
    throw new PublishRefused('This Phosphor service already has a Brain.')
  const marker: PublishedMarker = {
    version: 1,
    migrationId: record.migrationId,
    sourceGeneration: record.sourceGeneration,
  }
  const sealedBrain = join(paths.sealed, 'brain')
  writeRecord(join(sealedBrain, 'handover.json'), marker)
  try {
    // An empty folder is replaced; a folder with anything in it refuses (ENOTEMPTY / EEXIST).
    await rename(sealedBrain, paths.target)
  } catch (error) {
    if (errnoIs(error, 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'))
      throw new PublishRefused('This Phosphor service already has a Brain.')
    throw error
  }
  syncDirectory(dirname(paths.target))
  const next: HandoverRecord = { ...record, state: 'published' }
  writeRecord(paths.record, next)
  return next
}

/** Drops a settled move's private stage, sealed copies and scratch; its record stays. */
export async function dropPrivateCopies(stateDir: string, migrationId: string): Promise<void> {
  const paths = handoverPaths(stateDir, migrationId)
  await rm(paths.stage, { recursive: true, force: true })
  await rm(paths.sealed, { recursive: true, force: true })
  await rm(paths.scratch, { recursive: true, force: true })
}

async function releaseClaim(stateDir: string, migrationId: string): Promise<void> {
  const paths = handoverPaths(stateDir)
  if (readClaim(stateDir)?.migrationId !== migrationId) return
  await rm(paths.claim, { force: true })
  syncDirectory(paths.root)
}

/**
 * Binds a published move's Brain Agent conversation, then commits it. Desktop's `commit` and the
 * Host's restart share it; a failed binding leaves the move published for the next attempt.
 */
export async function completePublished(
  stateDir: string,
  record: HandoverRecord,
  importer: BrainAgentTranscriptImporter,
): Promise<HandoverRecord> {
  const paths = handoverPaths(stateDir, record.migrationId)
  const transcripts = (record.sealed ?? [])
    .filter((file) => file.path.startsWith('transcripts/') && file.sessionId)
    .map((file) => ({
      name: file.path.slice('transcripts/'.length),
      path: join(paths.sealed, file.path),
      sha256: file.sha256,
      bytes: file.bytes,
      sessionId: file.sessionId!,
    }))
  await importer({
    migrationId: record.migrationId,
    laneFolder: join(paths.target, 'Brain'),
    transcripts,
    active: record.active ?? null,
  })
  return await finishCommit(stateDir, record)
}

/**
 * Marks the move committed, releases the target claim and then drops the private copies the
 * published Brain and the imported conversation made redundant. Only after the durable record.
 */
export async function finishCommit(
  stateDir: string,
  record: HandoverRecord,
): Promise<HandoverRecord> {
  const next: HandoverRecord = { ...record, state: 'committed' }
  writeRecord(handoverPaths(stateDir, record.migrationId).record, next)
  await releaseClaim(stateDir, record.migrationId)
  await dropPrivateCopies(stateDir, record.migrationId)
  return next
}

/** Abandons an unpublished move: its stage and sealed copies go, the target claim is released. */
export async function abandon(stateDir: string, record: HandoverRecord): Promise<void> {
  await dropPrivateCopies(stateDir, record.migrationId)
  writeRecord(handoverPaths(stateDir, record.migrationId).record, {
    ...record,
    state: 'aborted',
    sealed: undefined,
  })
  await releaseClaim(stateDir, record.migrationId)
}

/**
 * A `begin` that stopped after its claim and before its record. Only an abort naming that exact
 * claim releases it, and never once a marker names it. Returns whether it released anything.
 */
export async function releaseOrphanClaim(stateDir: string, migrationId: string): Promise<boolean> {
  if (!isUuid(migrationId) || readClaim(stateDir)?.migrationId !== migrationId) return false
  if (readHandover(stateDir, migrationId)) return false
  if (readPublished(stateDir)?.migrationId === migrationId) return false
  await rm(handoverPaths(stateDir, migrationId).move, { recursive: true, force: true })
  await releaseClaim(stateDir, migrationId)
  return true
}

export type { PublishedMarker }
