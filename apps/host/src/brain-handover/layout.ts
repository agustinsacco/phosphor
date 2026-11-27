/**
 * Where a Brain handover lives in the Host's state directory, and its durable records.
 *
 * `<state>/brain/`                         the Host's Brain once published
 * `<state>/brain/handover.json`            written into the sealed copy before the rename, so
 *                                          ownership and publication are one atomic step
 * `<state>/brain-handover/active.json`     the claim on the empty target while a move runs
 * `<state>/brain-handover/<id>/state.json` one move's state, written temp + fsync + rename
 * `<state>/brain-handover/<id>/stage/`     the private folder the owner fills
 * `<state>/brain-handover/<id>/sealed/`    Host-made copies of verified bytes
 */
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { BrainHandoverReport, BrainHandoverState } from '@phosphor/shared/host-protocol-owner'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { atomicRecord, readBounded } from '@phosphor/session-runtime/host-install/files'

export const HOST_BRAIN_DIRECTORY = 'brain'
export const HANDOVER_DIRECTORY = 'brain-handover'
export const PUBLISHED_MARKER = 'handover.json'
const RECORD_BYTES = 256 * 1024

export interface SealedFile {
  /** Relative to `sealed/`: `brain/brain.sqlite`, `brain/Brain/AGENTS.md`, `transcripts/x.jsonl`… */
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  /** A transcript's pi session id, from its header. */
  readonly sessionId?: string
}

export interface HandoverRecord {
  readonly version: 1
  readonly migrationId: string
  readonly state: Exclude<BrainHandoverState, 'none'>
  readonly sourceSchema: 7 | 8
  readonly sourceGeneration: string
  readonly desktopVersion: string
  readonly sealed?: readonly SealedFile[]
  readonly report?: BrainHandoverReport
  /** The verified transcript (file name) the Brain lane resumes, or null for none. */
  readonly active?: string | null
}

export interface PublishedMarker {
  readonly version: 1
  readonly migrationId: string
  readonly sourceGeneration: string
}

export function handoverPaths(stateDir: string, migrationId = '') {
  const root = join(stateDir, HANDOVER_DIRECTORY)
  const move = join(root, migrationId)
  return {
    target: join(stateDir, HOST_BRAIN_DIRECTORY),
    marker: join(stateDir, HOST_BRAIN_DIRECTORY, PUBLISHED_MARKER),
    root,
    claim: join(root, 'active.json'),
    move,
    record: join(move, 'state.json'),
    stage: join(move, 'stage'),
    sealed: join(move, 'sealed'),
    scratch: join(move, 'scratch'),
  }
}

/** Makes a rename or a new entry in `directory` durable. */
export function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function writeRecord(path: string, value: object | number): void {
  atomicRecord(path, value, 0o600)
  syncDirectory(dirname(path))
}

function readJson<T>(path: string, valid: (v: Record<string, unknown>) => boolean): T | null {
  let text: string
  try {
    text = readBounded(path, RECORD_BYTES)
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return null
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || !valid(value as Record<string, unknown>))
    throw new Error(`Unreadable Brain handover record: ${path}`)
  return value as T
}

export function readHandover(stateDir: string, migrationId: string): HandoverRecord | null {
  return readJson(
    handoverPaths(stateDir, migrationId).record,
    (v) => v.version === 1 && v.migrationId === migrationId && typeof v.state === 'string',
  )
}

export function readClaim(stateDir: string): { migrationId: string } | null {
  return readJson(handoverPaths(stateDir).claim, (v) => typeof v.migrationId === 'string')
}

export function readPublished(stateDir: string): PublishedMarker | null {
  return readJson(
    handoverPaths(stateDir).marker,
    (v) => v.version === 1 && typeof v.migrationId === 'string',
  )
}

/** Whether the Host already has a Brain: anything in `<state>/brain`, or a non-folder there. */
export function targetOccupied(stateDir: string): boolean {
  const target = handoverPaths(stateDir).target
  try {
    const info = lstatSync(target)
    if (!info.isDirectory() || info.isSymbolicLink()) return true
    return readdirSync(target).length > 0
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return false
    throw error
  }
}

/** A private folder (0700); an existing one must be a real folder. */
export function privateFolder(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if (!errnoIs(error, 'EEXIST')) throw error
  }
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`Unsafe Brain handover folder: ${path}`)
}
