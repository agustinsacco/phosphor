import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, realpathSync } from 'node:fs'
import type { OwnerIndex, OwnerLaneRow } from '@phosphor/shared/host-protocol-owner'
import { parkedTranscript } from '@phosphor/session-runtime/lane-archive/files'
import type { ArchiveRecord } from '@phosphor/session-runtime/lane-archive/storage'
import { sessionPathKey } from '@phosphor/session-runtime/pi/session-path-lock'
import { IMPORT_STEPS, stepDone, type ImportStep, type MigrationJournal } from './journal'
import { sectionHash, type MigrationPlan } from './plan'
import { witnessChanges, type SessionWitness } from './witness'

/**
 * Step 12: the gates the staged migration must pass before the commit point
 * (D1 §3.7 with the lead's wave-8 decisions). Any failure aborts. Every read
 * is a port so each gate can be failed with one mutated input.
 */

export const GATES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11'] as const
export type Gate = (typeof GATES)[number]

/** Desktop's saved-transcript reader refuses files over this; such a spot checks bytes only. */
export const TRANSCRIPT_READER_MAX_BYTES = 64 * 1024 * 1024

export interface FileIdentity {
  readonly real: string
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly isFile: boolean
}

export interface VerifyPorts {
  /** Desktop's `readSavedTranscript`; rejects when it cannot read the file. */
  readonly readTranscript: (path: string) => Promise<unknown>
  readonly identity: (path: string) => FileIdentity | null
  /** SHA-256 hex of the file, streamed; rejects when `signal` aborts. */
  readonly hash: (path: string, signal: AbortSignal) => Promise<string>
  readonly exists: (path: string) => boolean
  /** Routine rows in Desktop's live routines database (0 when there is none). */
  readonly liveRoutines: () => number
  /** Routine rows in the backup's consistent copy (0 when there is none). */
  readonly copiedRoutines: () => number
  /** Claude accounts in Desktop's prefs now. */
  readonly accounts: () => number
  /** The session witness as taken now, over the plan's files. */
  readonly witnessNow: () => SessionWitness
  /** G11: M4's device re-key plan has no unresolved key outside its orphan allowlist. */
  readonly deviceGate?: () => boolean
}

export interface VerifyInput {
  readonly plan: MigrationPlan
  readonly journal: MigrationJournal
  readonly index: OwnerIndex
  readonly witness: SessionWitness | null
  readonly archives: readonly ArchiveRecord[]
  readonly desktop: { readonly agentDir: string; readonly sessionsRoot: string }
  readonly signal: AbortSignal
}

export type GateResult = { readonly ok: true } | { readonly ok: false; readonly gate: Gate }

const real = (path: string) => sessionPathKey(path)

/** Each staged section's import was acknowledged with the hash the plan holds. */
function staged(input: VerifyInput, step: ImportStep): boolean {
  const section = input.plan.sections[step]
  return section ? stepDone(input.journal, step, sectionHash(section)) : true
}

function rowsBy<K>(rows: readonly OwnerLaneRow[], key: (row: OwnerLaneRow) => K) {
  const map = new Map<K, OwnerLaneRow[]>()
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row])
  return map
}

/** G1: each planned lane is one service lane, under the planned id, and no file maps twice. */
function g1(input: VerifyInput): boolean {
  const byId = rowsBy(input.index.lanes, (row) => row.laneId)
  const byFile = rowsBy(input.index.lanes, (row) => row.sessionFile && real(row.sessionFile))
  return (input.plan.sections.lanes?.items ?? []).every(
    (item) =>
      byId.get(item.laneId)?.length === 1 && byFile.get(real(item.sessionFile))?.length === 1,
  )
}

/** G2: the service's cwd and session file for each planned lane equal the plan's. */
function g2(input: VerifyInput): boolean {
  const byId = new Map(input.index.lanes.map((row) => [row.laneId, row]))
  return (input.plan.sections.lanes?.items ?? []).every((item) => {
    const row = byId.get(item.laneId)
    return (
      !!row?.sessionFile && row.cwd === item.cwd && real(row.sessionFile) === real(item.sessionFile)
    )
  })
}

/**
 * One spot lane (G3): Desktop's reader opens it when it is within the
 * reader's cap, and the service's file is the same file (realpath, dev and
 * inode) or, when it is a different file, has the same bytes.
 */
export async function spotMatches(
  ports: VerifyPorts,
  desktopPath: string,
  servicePath: string,
  signal: AbortSignal,
): Promise<boolean> {
  const mine = ports.identity(desktopPath)
  const theirs = ports.identity(servicePath)
  if (!mine?.isFile || !theirs?.isFile) return false
  if (mine.size <= TRANSCRIPT_READER_MAX_BYTES) {
    const read = await ports.readTranscript(desktopPath).then(
      () => true,
      () => false,
    )
    if (!read) return false
  }
  if (mine.real === theirs.real && mine.dev === theirs.dev && mine.ino === theirs.ino) return true
  const [a, b] = await Promise.all([
    ports.hash(desktopPath, signal),
    ports.hash(servicePath, signal),
  ])
  return a === b
}

async function g3(input: VerifyInput, ports: VerifyPorts): Promise<boolean> {
  const byId = new Map(input.index.lanes.map((row) => [row.laneId, row]))
  for (const spot of input.plan.spots) {
    const laneId = input.plan.laneIds[spot]
    const row = laneId ? byId.get(laneId) : undefined
    if (!row?.sessionFile) return false
    if (!(await spotMatches(ports, spot, row.sessionFile, input.signal))) return false
  }
  return true
}

/** G6: each archived lane's parked transcript (or, mid-operation, either copy) is on disk. */
function parkedPresent(record: ArchiveRecord, exists: (path: string) => boolean): boolean {
  if (!record.transcript) return true
  if (record.state === 'archived') return exists(parkedTranscript(record))
  return exists(parkedTranscript(record)) || exists(record.transcript)
}

/** G10: the service indexes the same agent folder and sessions root Desktop uses. */
function g10(input: VerifyInput): boolean {
  return (
    real(input.index.agentDir) === real(input.desktop.agentDir) &&
    real(input.index.sessionsRoot) === real(input.desktop.sessionsRoot)
  )
}

/** The gates in order; the first that fails names the journal's failure code. */
export async function verifyMigration(input: VerifyInput, ports: VerifyPorts): Promise<GateResult> {
  const checks: [Gate, () => boolean | Promise<boolean>][] = [
    ['G10', () => g10(input)],
    ['G1', () => staged(input, 'lanes') && g1(input)],
    ['G2', () => g2(input)],
    ['G3', () => g3(input, ports)],
    ['G4', () => staged(input, 'marks') && staged(input, 'folders')],
    ['G5', () => staged(input, 'routines') && ports.copiedRoutines() === ports.liveRoutines()],
    [
      'G6',
      () =>
        staged(input, 'archives') &&
        input.archives.length === input.plan.expected.archives &&
        input.archives.every((record) => parkedPresent(record, ports.exists)),
    ],
    [
      'G7',
      () =>
        staged(input, 'accounts') &&
        staged(input, 'artifacts') &&
        ports.accounts() === input.plan.expected.accounts,
    ],
    ['G8', () => !!input.witness && witnessChanges(input.witness, ports.witnessNow()).length === 0],
    ['G9', () => staged(input, 'policy')],
    ['G11', () => ports.deviceGate?.() ?? true],
  ]
  for (const [gate, check] of checks) if (!(await check())) return { ok: false, gate }
  return IMPORT_STEPS.every((step) => staged(input, step))
    ? { ok: true }
    : { ok: false, gate: 'G1' }
}

/** The failure code a gate writes to the journal. */
export const gateCode = (gate: Gate) => `gate-${gate.toLowerCase()}`

/** Production file ports for G3. */
export const fileVerifyPorts = {
  identity(path: string): FileIdentity | null {
    try {
      const info = lstatSync(path)
      return {
        real: realpathSync.native(path),
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        isFile: info.isFile(),
      }
    } catch {
      return null
    }
  },
  hash(path: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const digest = createHash('sha256')
      const stream = createReadStream(path, { signal })
      stream.on('data', (chunk) => digest.update(chunk))
      stream.once('error', reject)
      stream.once('end', () => resolve(digest.digest('hex')))
    })
  },
}
