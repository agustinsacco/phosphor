import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isArchiveId, type LaneArchiveEntry } from '@phosphor/shared/lane-archive'
import { mapLimit } from '../map-limit'
import {
  assertArchiveDirectory,
  assertPurgeIdentity,
  missing,
  moveTranscript,
  parkedTranscript,
} from './files'

export interface ArchiveRecord extends LaneArchiveEntry {
  version: 1
  /** Original pi path. Undefined before pi saved a conversation. */
  transcript?: string
  identity?: { dev: number; ino: number; directory: string }
  repository?: string
  checkout?: { dev: number; ino: number; path: string }
  /** Adapter-owned recovery identity, never sent to the UI. */
  metadata?: Record<string, unknown>
}
type ArchiveInput = Omit<
  ArchiveRecord,
  'version' | 'archivedAt' | 'state' | 'identity' | 'checkout'
>
export const archiveIdFor = (path: string) =>
  createHash('sha256').update(resolve(path)).digest('hex')

/** Durable intents. Adapters hold their existing lane/path locks for whole operations. */
export class LaneArchiveStorage {
  constructor(
    private readonly root: string,
    private readonly sessionsRoot: string,
  ) {}
  private file(id: string) {
    if (!isArchiveId(id)) throw new Error('Invalid archive ID')
    return join(this.root, `${id}.json`)
  }
  private validate(value: unknown): ArchiveRecord {
    const r = value as Partial<ArchiveRecord> | null
    if (
      !r ||
      r.version !== 1 ||
      !isArchiveId(r.id) ||
      typeof r.title !== 'string' ||
      typeof r.cwd !== 'string' ||
      !Number.isFinite(r.archivedAt) ||
      !['archiving', 'archived', 'restoring', 'purging'].includes(r.state ?? '') ||
      (r.transcript !== undefined &&
        (typeof r.transcript !== 'string' ||
          !r.transcript.endsWith('.jsonl') ||
          dirname(dirname(resolve(r.transcript))) !== resolve(this.sessionsRoot) ||
          !Number.isFinite(r.identity?.dev) ||
          !Number.isFinite(r.identity?.ino) ||
          typeof r.identity?.directory !== 'string'))
    )
      throw new Error('Invalid archive record')
    return r as ArchiveRecord
  }
  private async save(record: ArchiveRecord) {
    this.validate(record)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const temp = join(this.root, `${record.id}.${randomUUID()}.tmp`)
    try {
      await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx', flush: true })
      await rename(temp, this.file(record.id))
      if (process.platform !== 'win32') {
        const directory = await open(this.root, 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
    } finally {
      await rm(temp, { force: true })
    }
  }
  async get(id: string): Promise<ArchiveRecord> {
    const record = this.validate(JSON.parse(await readFile(this.file(id), 'utf8')))
    if (record.id !== id) throw new Error('Archive identity mismatch')
    return record
  }
  async list(): Promise<{ entries: ArchiveRecord[]; truncated: boolean }> {
    const names = await readdir(this.root).catch((error: unknown) => {
      if (missing(error)) return []
      throw error
    })
    const ids = names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
    const entries = await mapLimit(ids.slice(0, 1000), 4, (id) => this.get(id))
    return {
      entries: entries.sort((a, b) => b.archivedAt - a.archivedAt),
      truncated: ids.length > 1000,
    }
  }
  /** Save intent before changing discovery. Failed work stays visible in Archive. */
  async prepare(input: ArchiveInput) {
    const existing = await this.get(input.id).catch((error: unknown) => {
      if (missing(error)) return null
      throw error
    })
    if (existing) {
      if (existing.cwd !== input.cwd || existing.transcript !== input.transcript)
        throw new Error('This archive ID already belongs to a different lane.')
      return existing
    }
    if ((await this.list()).entries.length >= 1000)
      throw new Error('Archive is full. Clean up archived lanes first.')
    // A worktree removed outside Phosphor still archives; with no identity, cleanup removes nothing.
    const checkout = input.worktree
      ? await lstat(input.cwd).catch((error: unknown) => {
          if (missing(error)) return null
          throw error
        })
      : null
    if (checkout && !checkout.isDirectory())
      throw new Error('The checkout is not a regular directory.')
    const info = input.transcript ? await lstat(input.transcript) : null
    if (info && !info.isFile()) throw new Error('Only regular session files can be archived.')
    const record: ArchiveRecord = {
      ...input,
      version: 1,
      archivedAt: Date.now(),
      state: 'archiving',
      ...(checkout
        ? { checkout: { dev: checkout.dev, ino: checkout.ino, path: await realpath(input.cwd) } }
        : {}),
      ...(info && input.transcript
        ? {
            identity: {
              dev: info.dev,
              ino: info.ino,
              directory: await realpath(dirname(input.transcript)),
            },
          }
        : {}),
    }
    this.validate(record)
    await assertArchiveDirectory(record, this.sessionsRoot)
    await this.save(record)
    return record
  }
  /**
   * Keep a record another runtime wrote (This Mac's migration), as it is: its
   * transcript is already parked. An id that holds a different lane is refused.
   */
  async adopt(record: ArchiveRecord) {
    this.validate(record)
    const existing = await this.get(record.id).catch((error: unknown) => {
      if (missing(error)) return null
      throw error
    })
    if (existing) {
      if (existing.cwd !== record.cwd || existing.transcript !== record.transcript)
        throw new Error('This archive ID already belongs to a different lane.')
      return existing
    }
    await assertArchiveDirectory(record, this.sessionsRoot, true)
    await this.save(record)
    return record
  }
  async archive(id: string) {
    const record = await this.get(id)
    if (record.state !== 'archiving' && record.state !== 'archived')
      throw new Error('This archive has another unfinished operation.')
    await assertArchiveDirectory(record, this.sessionsRoot)
    if (record.transcript)
      await moveTranscript(record.transcript, parkedTranscript(record), record.identity)
    await this.save({ ...record, state: 'archived' })
  }
  /** Keep the intent until the adapter restores its lane metadata too. */
  async restore(id: string) {
    const record = await this.get(id)
    if (record.state === 'purging') throw new Error('Cleanup has started; retry cleanup instead.')
    await this.save({ ...record, state: 'restoring' })
    await assertArchiveDirectory(record, this.sessionsRoot)
    if (record.transcript)
      await moveTranscript(parkedTranscript(record), record.transcript, record.identity)
    return record
  }
  async purge(id: string, cleanup: (record: ArchiveRecord) => Promise<void>) {
    const record = await this.get(id)
    // An empty lane mid-restore moved nothing back, so it may still be cleaned up.
    const emptyRestore = record.state === 'restoring' && !record.transcript
    if (record.state !== 'archived' && record.state !== 'purging' && !emptyRestore)
      throw new Error('Restore this incomplete archive before cleaning it up.')
    await assertArchiveDirectory(record, this.sessionsRoot, true)
    await assertPurgeIdentity(record)
    await this.save({ ...record, state: 'purging' })
    await cleanup(record)
    if (record.transcript) {
      await rm(parkedTranscript(record), { force: true })
      // Exact transcript-owned runs, never the cwd-wide subagent-artifacts folder.
      await rm(record.transcript.slice(0, -6), { recursive: true, force: true })
    }
  }
  finish(id: string) {
    return rm(this.file(id), { force: true })
  }
}
export const createLaneArchiveStorage = (root: string, sessionsRoot: string) =>
  new LaneArchiveStorage(root, sessionsRoot)
