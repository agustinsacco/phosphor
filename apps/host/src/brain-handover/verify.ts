/**
 * Checks a sealed Brain before the Host may publish it: same schema and generation the owner
 * announced, sound before and after the engine's own upgrade, the same content on the columns
 * both versions share, a disposable copy that opens, recalls, walks and undoes, and Brain Agent
 * transcripts with a session header. The upgraded bytes are hashed again: those are published.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  brainHandoverDigest,
  brainIntegrityProblems,
  brainSourceSessions,
  compareBrainHandover,
  exerciseBrainCopy,
  upgradeBrainDatabase,
} from '@phosphor/memory-engine/handover'
import type { BrainHandoverReport } from '@phosphor/shared/host-protocol-owner'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import type { HandoverRecord, SealedFile } from './layout'
import type { SealResult } from './seal'

export class VerifyRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerifyRefused'
  }
}

const HEADER_BYTES = 64 * 1024

async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
    bytes += (chunk as Buffer).length
  }
  return { sha256: hash.digest('hex'), bytes }
}

/** The pi session id in a transcript's first line. */
async function transcriptSession(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
    const line = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? ''
    const header: unknown = JSON.parse(line)
    const value = header as { type?: unknown; id?: unknown }
    if (value.type === 'session' && typeof value.id === 'string' && value.id.length <= 200)
      return value.id
  } catch {
    // Refused below.
  } finally {
    await handle.close()
  }
  throw new VerifyRefused('A Brain Agent transcript has no session header.')
}

interface Checked {
  readonly from: number
  readonly counts: Record<string, number>
  readonly lanes: readonly string[]
}

/** Upgrades the sealed database in place and returns what the report needs. */
function checkDatabase(path: string, record: HandoverRecord): Checked {
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(path)
  try {
    const before = brainHandoverDigest(db, { upgradeV7: record.sourceSchema === 7 })
    if (before.schema !== record.sourceSchema || before.generation !== record.sourceGeneration)
      throw new VerifyRefused('The staged Brain is not the one this move began with.')
    const unsound = brainIntegrityProblems(db)
    if (unsound.length > 0) throw new VerifyRefused(`The staged Brain is damaged: ${unsound[0]}`)
    const sources = brainSourceSessions(db)
    upgradeBrainDatabase(db)
    const problems = [
      ...brainIntegrityProblems(db),
      ...compareBrainHandover(before, db, DatabaseSync),
    ]
    if (problems.length > 0)
      throw new VerifyRefused(`The moved Brain differs: ${problems.slice(0, 3).join('; ')}`)
    return { from: before.schema, counts: { ...before.counts }, lanes: sources.lanes }
  } finally {
    db.close()
  }
}

export async function verifySealed(input: {
  readonly sealedDir: string
  readonly scratch: string
  readonly record: HandoverRecord
  readonly seal: SealResult
  readonly laneForSessionFile: (path: string) => boolean
  readonly now: number
  /** The staged name Desktop resumes next (`transcripts/<file>.jsonl`), or null. */
  readonly activeTranscript: string | null
}): Promise<{ sealed: SealedFile[]; report: BrainHandoverReport; active: string | null }> {
  const transcripts = input.seal.sealed.filter((f) => f.path.startsWith('transcripts/'))
  // Never guess which conversation continues, and never start one fresh over history.
  if (input.activeTranscript === null && transcripts.length > 0)
    throw new VerifyRefused('Desktop did not say which Brain Agent conversation continues.')
  if (
    input.activeTranscript !== null &&
    !transcripts.some((f) => f.path === input.activeTranscript)
  )
    throw new VerifyRefused('The Brain Agent conversation that continues was not staged.')
  const database = join(input.sealedDir, 'brain', 'brain.sqlite')
  const checked = checkDatabase(database, input.record)
  if (existsSync(`${database}-wal`)) throw new VerifyRefused('The upgraded Brain did not settle.')
  await rm(`${database}-shm`, { force: true })
  await mkdir(input.scratch, { recursive: true, mode: 0o700 })
  try {
    const copy = join(input.scratch, 'brain.sqlite')
    await copyFile(database, copy)
    await exerciseBrainCopy(loadSqlite().DatabaseSync, copy, input.now)
  } catch (error) {
    if (error instanceof VerifyRefused) throw error
    throw new VerifyRefused('A disposable copy of the moved Brain did not open.')
  } finally {
    await rm(input.scratch, { recursive: true, force: true })
  }
  const sealed: SealedFile[] = []
  for (const file of input.seal.sealed) {
    const path = join(input.sealedDir, file.path)
    if (file.path === 'brain/brain.sqlite')
      sealed.push({ path: file.path, ...(await sha256File(path)) })
    else if (file.path.startsWith('transcripts/'))
      sealed.push({ ...file, sessionId: await transcriptSession(path) })
    else sealed.push(file)
    await chmod(path, 0o400)
  }
  const mapped = checked.lanes.filter((path) => input.laneForSessionFile(path)).length
  const active = input.activeTranscript?.slice('transcripts/'.length) ?? null
  return {
    sealed,
    active,
    report: {
      schema: { from: checked.from, to: 8 },
      counts: checked.counts,
      sources: { lanes: checked.lanes.length, mapped, missing: checked.lanes.length - mapped },
      agent: {
        transcripts: transcripts.length,
        rules: sealed.some((f) => f.path === 'brain/Brain/AGENTS.md'),
        active: active !== null,
      },
      model: input.seal.model,
    },
  }
}
