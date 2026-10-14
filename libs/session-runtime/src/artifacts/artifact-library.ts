import { readFile, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  blobFile,
  currentVersion,
  indexFile,
  readAllIndexes,
  type SessionArtifactIndex,
  type StoredArtifact,
} from '@phosphor/pi-extensions/artifact-store'
import type { ArtifactListing, ArtifactSnapshot } from '@phosphor/shared/artifacts'
import { indexSessionFile, writeIndex } from './artifact-indexer'

type Log = (scope: string, message: string, data?: Record<string, unknown>) => void

/** Quiet period after a turn ends before its file is indexed. */
const SETTLE_MS = 750

/**
 * Phosphor's artifact store, from the main process: the ONLY writer.
 *
 * Holds every session index in memory (they carry no content, a few KB each)
 * and serialises work per session file, so the per-turn trigger, a pane
 * opening and the backfill can never index one file twice at once.
 */
export class ArtifactLibrary {
  private readonly indexes = new Map<string, SessionArtifactIndex>()
  private readonly byFile = new Map<string, string>()
  private loading: Promise<void> | null = null
  private readonly queues = new Map<string, Promise<SessionArtifactIndex | null>>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly root: () => string,
    private readonly log: Log = () => undefined,
  ) {}

  private load(): Promise<void> {
    this.loading ??= Promise.resolve().then(() => {
      for (const index of readAllIndexes(this.root())) this.remember(index)
    })
    return this.loading
  }

  private remember(index: SessionArtifactIndex): void {
    const old = this.indexes.get(index.sessionId)
    if (old && old.sessionFile !== index.sessionFile) this.byFile.delete(old.sessionFile)
    this.indexes.set(index.sessionId, index)
    this.byFile.set(index.sessionFile, index.sessionId)
  }

  private indexFor(path: string): SessionArtifactIndex | null {
    const id = this.byFile.get(path)
    return id ? (this.indexes.get(id) ?? null) : null
  }

  /**
   * Index one session file now. Resolves to its index, or null if it has none.
   *
   * A file that is gone, however it went (deleted here, in Finder, by pi
   * itself), leaves its artifacts behind marked as such.
   */
  indexFile(path: string): Promise<SessionArtifactIndex | null> {
    const previous = this.queues.get(path) ?? Promise.resolve(null)
    const next = previous
      .catch(() => null)
      .then(async () => {
        await this.load()
        const before = this.indexFor(path)
        const after = await indexSessionFile(this.root(), path, before)
        if (after) {
          if (after !== before) await this.save(after)
          return after
        }
        if (!before || before.deleted || (await exists(path))) return before
        return this.markDeleted(before)
      })
    this.queues.set(path, next)
    void next.finally(() => {
      if (this.queues.get(path) === next) this.queues.delete(path)
    })
    return next
  }

  /** Index once the file settles. For turn ends, where pi is still writing. */
  schedule(path: string): void {
    clearTimeout(this.timers.get(path))
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path)
        this.indexFile(path).catch((error: unknown) =>
          this.log('artifacts', 'index failed', { path, error: String(error) }),
        )
      }, SETTLE_MS),
    )
  }

  /** What a session's pane shows: each artifact's versions on the current branch. */
  async forSession(path: string): Promise<ArtifactSnapshot[]> {
    const index = await this.indexFile(path)
    if (!index) return []
    const snapshots: ArtifactSnapshot[] = []
    for (const artifact of Object.values(index.artifacts)) {
      const snapshot = await this.snapshot(artifact)
      if (snapshot) snapshots.push(snapshot)
    }
    return snapshots
  }

  private async snapshot(artifact: StoredArtifact): Promise<ArtifactSnapshot | null> {
    const versions = artifact.versions
      .filter((v) => v.onBranch)
      .sort((a, b) => a.version - b.version)
    if (versions.length === 0) return null
    const loaded = []
    for (const version of versions) {
      const content = await readFile(blobFile(this.root(), version.sha256), 'utf8').catch(
        () => null,
      )
      // A missing blob drops one version, never the artifact.
      if (content === null) continue
      loaded.push({
        version: version.version,
        title: version.title,
        content,
        createdAt: Date.parse(version.createdAt) || 0,
      })
    }
    if (loaded.length === 0) return null
    const latest = loaded[loaded.length - 1]!
    return {
      id: artifact.slug,
      title: latest.title || artifact.title,
      type: artifact.type,
      language: artifact.language,
      versions: loaded,
    }
  }

  /**
   * Every artifact the store knows. `livePaths` are the files of open
   * sessions, brought up to date first so a turn that just ended shows.
   */
  async list(livePaths: string[] = []): Promise<ArtifactListing[]> {
    await this.load()
    await Promise.all(livePaths.map((path) => this.indexFile(path).catch(() => null)))
    await this.reconcile()
    const indexes = [...this.indexes.values()]
    const folders = await existingFolders(indexes.map((index) => index.cwd))
    return indexes.flatMap((index) =>
      Object.values(index.artifacts).flatMap((artifact) => {
        const listing = listingFor(index, artifact, folders.has(index.cwd))
        return listing ? [listing] : []
      }),
    )
  }

  /** Notice session files that went without this library being told. */
  private async reconcile(): Promise<void> {
    await Promise.all(
      [...this.indexes.values()]
        .filter((index) => !index.deleted)
        .map(async (index) => {
          if (!(await exists(index.sessionFile))) {
            await this.indexFile(index.sessionFile).catch(() => null)
          }
        }),
    )
  }

  /** One artifact with its content, for viewing outside its session. */
  async read(
    key: string,
  ): Promise<{ listing: ArtifactListing; artifact: ArtifactSnapshot } | null> {
    await this.load()
    const found = this.byKey(key)
    if (!found) return null
    const folders = await existingFolders([found.index.cwd])
    const listing = listingFor(found.index, found.artifact, folders.has(found.index.cwd))
    const artifact = await this.snapshot(found.artifact)
    return listing && artifact ? { listing, artifact } : null
  }

  private byKey(key: string): { index: SessionArtifactIndex; artifact: StoredArtifact } | null {
    const slash = key.indexOf('/')
    if (slash === -1) return null
    const index = this.indexes.get(key.slice(0, slash))
    const artifact = index?.artifacts[key.slice(slash + 1)]
    return index && artifact ? { index, artifact } : null
  }

  /**
   * Keep a gone session's artifacts under a "session deleted" mark until they
   * are removed here. With none, the index was only a scan watermark.
   */
  private async markDeleted(index: SessionArtifactIndex): Promise<SessionArtifactIndex | null> {
    if (Object.keys(index.artifacts).length === 0) {
      await this.forget(index)
      return null
    }
    const deleted = { ...index, deleted: true }
    await this.save(deleted)
    return deleted
  }

  private async save(index: SessionArtifactIndex): Promise<void> {
    await writeIndex(this.root(), index)
    this.remember(index)
  }

  /**
   * Remove an artifact whose session was deleted. A live session's artifacts
   * are part of its history and go with the session, so they are refused.
   */
  async remove(key: string): Promise<boolean> {
    await this.load()
    const found = this.byKey(key)
    if (!found || !found.index.deleted) return false
    const { [found.artifact.slug]: removed, ...rest } = found.index.artifacts
    const next = { ...found.index, artifacts: rest }
    if (Object.keys(rest).length === 0) await this.forget(next)
    else await this.save(next)
    await this.collect(removed?.versions.map((v) => v.sha256) ?? [])
    return true
  }

  private async forget(index: SessionArtifactIndex): Promise<void> {
    await unlink(indexFile(this.root(), index.sessionId)).catch(() => undefined)
    this.indexes.delete(index.sessionId)
    this.byFile.delete(index.sessionFile)
  }

  /** Delete the blobs no index refers to any more. */
  private async collect(candidates: string[]): Promise<void> {
    if (candidates.length === 0) return
    const referenced = new Set<string>()
    for (const index of this.indexes.values()) {
      for (const artifact of Object.values(index.artifacts)) {
        for (const version of artifact.versions) referenced.add(version.sha256)
      }
    }
    for (const sha256 of new Set(candidates)) {
      if (!referenced.has(sha256)) {
        await unlink(blobFile(this.root(), sha256)).catch(() => undefined)
      }
    }
  }

  /**
   * Index every session file under pi's sessions root that changed since the
   * last pass. The first pass is what brings back artifacts that only lived in
   * old sessions. One file at a time, yielding between them.
   */
  async backfill(sessionsRoot: string): Promise<{ indexed: number; failed: number }> {
    await this.load()
    let indexed = 0
    let failed = 0
    let dirs: string[]
    try {
      dirs = await readdir(sessionsRoot)
    } catch {
      return { indexed, failed }
    }
    for (const dir of dirs) {
      let files: string[]
      try {
        files = await readdir(join(sessionsRoot, dir))
      } catch {
        continue
      }
      for (const name of files) {
        if (!name.endsWith('.jsonl')) continue
        const path = join(sessionsRoot, dir, name)
        const known = this.indexFor(path)
        if (known) {
          const info = await stat(path).catch(() => null)
          if (info && info.size === known.scan.size && info.mtimeMs === known.scan.mtimeMs) continue
        }
        try {
          await this.indexFile(path)
          indexed++
        } catch (error) {
          failed++
          this.log('artifacts', 'backfill failed', { path, error: String(error) })
        }
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    await this.reconcile()
    return { indexed, failed }
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

/** Which of these folders are still there, each checked once. */
async function existingFolders(paths: string[]): Promise<Set<string>> {
  const unique = [...new Set(paths)].filter(Boolean)
  const found = await Promise.all(unique.map(async (path) => ((await exists(path)) ? path : null)))
  return new Set(found.filter((path): path is string => path !== null))
}

function listingFor(
  index: SessionArtifactIndex,
  artifact: StoredArtifact,
  workspaceExists: boolean,
): ArtifactListing | null {
  const version = currentVersion(artifact)
  if (!version) return null
  return {
    key: `${index.sessionId}/${artifact.slug}`,
    sessionId: index.sessionId,
    id: artifact.slug,
    sessionFile: index.sessionFile,
    cwd: index.cwd,
    sessionName: index.name,
    firstUserText: index.firstUserText,
    title: version.title || artifact.title,
    type: artifact.type,
    language: artifact.language,
    version: version.version,
    versionCount: artifact.versions.filter((v) => v.onBranch).length,
    updatedAt: Date.parse(version.createdAt) || 0,
    revision: version.toolCallId,
    sessionDeleted: index.deleted,
    workspaceExists,
  }
}
