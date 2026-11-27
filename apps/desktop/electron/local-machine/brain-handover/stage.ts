/**
 * Desktop's half of staging a Brain move: with Brain's writers fenced, settle the WAL, take an
 * online-backup copy into the service's private staging folder and prove it matches the file it
 * came from; copy Brain Agent's rules, every transcript in its lane's pi folder and the verified
 * embedding model. Returns each staged file's size and hash, and which transcript Desktop would
 * resume next. Originals are only read.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { backup, DatabaseSync } from 'node:sqlite'
import { newestTranscript } from '@phosphor/brain-runtime/agent/agent-lane'
import {
  backupBrainDatabase,
  brainHandoverDigest,
  brainSchemaVersion,
} from '@phosphor/memory-engine/handover'
import { isBrainHandoverName, type BrainHandoverFile } from '@phosphor/shared/host-protocol-owner'

export interface DesktopBrainSources {
  readonly sqlite: { readonly DatabaseSync: typeof DatabaseSync; readonly backup: typeof backup }
  /** `<userData>/brain/brain.sqlite`. */
  readonly database: string
  /** Brain Agent's lane folder, holding `AGENTS.md`. */
  readonly laneFolder: string
  /** pi's transcript folder for that lane. */
  readonly transcripts: string
  /** The verified embedding model folder and its pinned files, relative to it. */
  readonly model: {
    readonly folder: string
    readonly directoryName: string
    readonly files: readonly { readonly path: string; readonly bytes: number }[]
  }
}

export class StageRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StageRefused'
  }
}

async function regularFile(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null)
  return info?.isFile() === true
}

async function describe(staging: string, name: string): Promise<BrainHandoverFile> {
  const path = join(staging, name)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return { name, bytes: (await stat(path)).size, sha256: hash.digest('hex') }
}

async function stageCopy(from: string, staging: string, name: string): Promise<void> {
  if (!isBrainHandoverName(name)) throw new StageRefused(`Brain cannot move a file named ${name}.`)
  const to = join(staging, name)
  await mkdir(dirname(to), { recursive: true, mode: 0o700 })
  await copyFile(from, to)
  await chmod(to, 0o600)
}

/** The schema and generation `begin` announces. */
export function brainSourceIdentity(
  sources: DesktopBrainSources,
): { schema: number; generation: string } | null {
  let db: DatabaseSync
  try {
    db = new sources.sqlite.DatabaseSync(sources.database, { readOnly: true })
  } catch {
    return null
  }
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='generation'").get() as
      { value: string } | undefined
    return row ? { schema: brainSchemaVersion(db), generation: row.value } : null
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** Folds the WAL into the file as its owner would on close, so the original stands alone. */
function settleWal(sources: DesktopBrainSources): void {
  const db = new sources.sqlite.DatabaseSync(sources.database, { timeout: 2000 })
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

function sameContent(sources: DesktopBrainSources, copy: string): boolean {
  const digest = (path: string) => {
    const db = new sources.sqlite.DatabaseSync(path, { readOnly: true })
    try {
      const { tables, prefs, schema, generation } = brainHandoverDigest(db)
      return JSON.stringify({ tables, prefs, schema, generation })
    } finally {
      db.close()
    }
  }
  return digest(sources.database) === digest(copy)
}

/**
 * Whether every pinned model file is on this Mac at its pinned size. The service hashes them;
 * this only keeps a Mac without a model from fencing its Brain for a move that cannot finish.
 */
export async function desktopModelPresent(sources: DesktopBrainSources): Promise<boolean> {
  for (const file of sources.model.files) {
    const info = await lstat(join(sources.model.folder, file.path)).catch(() => null)
    if (!info?.isFile() || info.size !== file.bytes) return false
  }
  return sources.model.files.length > 0
}

export interface StagedDesktopBrain {
  readonly files: BrainHandoverFile[]
  /** The staged transcript Desktop's Brain lane resumes next, or null when it has none. */
  readonly activeTranscript: string | null
}

export async function stageDesktopBrain(
  sources: DesktopBrainSources,
  staging: string,
): Promise<StagedDesktopBrain> {
  settleWal(sources)
  const copy = join(staging, 'brain.sqlite')
  await backupBrainDatabase(sources.sqlite, sources.database, copy)
  await chmod(copy, 0o600)
  if (!sameContent(sources, copy))
    throw new StageRefused('Brain changed while it was copied. Try again.')
  const names = ['brain.sqlite']
  const rules = join(sources.laneFolder, 'AGENTS.md')
  if (await regularFile(rules)) {
    await stageCopy(rules, staging, 'AGENTS.md')
    names.push('AGENTS.md')
  }
  // The conversation Brain Agent continues is the one this Desktop resumes (`newestTranscript`).
  const resumes = await newestTranscript(sources.transcripts)
  const transcripts = await readdir(sources.transcripts).catch(() => [] as string[])
  let activeTranscript: string | null = null
  for (const file of transcripts.filter((f) => f.endsWith('.jsonl')).sort()) {
    const from = join(sources.transcripts, file)
    if (!(await regularFile(from))) {
      if (from === resumes)
        throw new StageRefused('Brain Agent’s conversation is not a plain file.')
      continue
    }
    await stageCopy(from, staging, `transcripts/${file}`)
    names.push(`transcripts/${file}`)
    if (from === resumes) activeTranscript = `transcripts/${file}`
  }
  if (resumes !== null && activeTranscript === null)
    throw new StageRefused('Brain Agent’s conversation could not be staged.')
  const prefix = `embeddings/embedding-models/${sources.model.directoryName}`
  for (const file of sources.model.files) {
    const from = join(sources.model.folder, file.path)
    if (!(await regularFile(from))) throw new StageRefused('Brain’s embedding model is incomplete.')
    await stageCopy(from, staging, `${prefix}/${file.path}`)
    names.push(`${prefix}/${file.path}`)
  }
  const files: BrainHandoverFile[] = []
  for (const name of names) files.push(await describe(staging, name))
  return { files, activeTranscript }
}
