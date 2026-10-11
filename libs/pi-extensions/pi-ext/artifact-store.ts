/**
 * The on-disk format of Phosphor's artifact store, and the read side of it.
 *
 * Not an extension: it is a module imported by two sides that must agree on
 * the format. The main process (`apps/desktop/electron/artifacts/`) is the
 * ONLY writer. The artifacts extension, running inside pi, only reads, to
 * answer for artifacts that belong to OTHER sessions. A session's own
 * artifacts never come from here: they are rebuilt from its own branch, so a
 * missing or broken store can never change what a session can do with them.
 *
 * Layout under the store root (`<userData>/artifacts`):
 *
 *   blobs/<sha256>            one immutable file per distinct content
 *   sessions/<sessionId>.json one index per pi session file
 *
 * The store is DERIVED from pi's session files, so deleting it loses only the
 * artifacts of sessions whose files are gone. Everything else is rebuilt.
 *
 * Only node built-ins here: pi loads the extension that imports this file
 * straight from disk.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** The env var a Phosphor-spawned pi gets, naming the store root. */
export const ARTIFACT_STORE_ENV = 'PHOSPHOR_ARTIFACT_STORE'
/** Pi-owned, non-context artifact created by an explicit host save command. */
export const ARTIFACT_ENTRY_TYPE = 'phosphor-saved-artifact'

/** Indexer revision: older readable indexes are rescanned when their session file exists. */
export const ARTIFACT_INDEX_FORMAT = 2

export const ARTIFACT_TYPES = ['html', 'markdown', 'svg', 'mermaid', 'code', 'chart'] as const
export type StoredArtifactType = (typeof ARTIFACT_TYPES)[number]

/** The tools whose results mint a version. Reads and lists never do. */
export const ARTIFACT_WRITE_TOOLS: readonly string[] = [
  'artifact_create',
  'artifact_update',
  'artifact_edit',
]

export interface StoredArtifactVersion {
  version: number
  /** Unique per tool call, so the same result indexed twice is one version. */
  toolCallId: string
  /** The session entry holding the result, for branch membership. */
  entryId: string
  sha256: string
  bytes: number
  /** ISO time of the entry that recorded it. */
  createdAt: string
  title: string
  /** On the file's current branch (leaf = last entry, as pi loads it). */
  onBranch: boolean
}

export interface StoredArtifact {
  slug: string
  title: string
  type: StoredArtifactType
  language?: string
  /** In file order. Every branch is kept; `onBranch` says which one counts. */
  versions: StoredArtifactVersion[]
}

export interface ArtifactIndexScan {
  /** Byte offset just past the last complete line read. */
  offset: number
  size: number
  mtimeMs: number
  /** Base64 of the bytes ending at `offset`, proving the next read is an append. */
  signature: string
  /** Id of the last entry read: pi's leaf when it loads the file. */
  leafId: string | null
}

export interface SessionArtifactIndex {
  /** V1 remains readable, especially when its source session was deleted. */
  format: 1 | typeof ARTIFACT_INDEX_FORMAT
  sessionId: string
  sessionFile: string
  cwd: string
  createdAt?: string
  parentSession?: string
  /** Latest `session_info` name, if the session was ever named. */
  name?: string
  firstUserText?: string
  /** The session file was deleted. Its artifacts stay until removed by hand. */
  deleted: boolean
  scan: ArtifactIndexScan
  artifacts: Record<string, StoredArtifact>
}

/** pi session ids are UUIDs; anything else never reaches a path. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/
/** What `slugifyArtifactId` can produce, plus a `-N` de-duplication suffix. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const SHA256 = /^[a-f0-9]{64}$/
/** A session prefix shorter than this is too easy to match by accident. */
export const MIN_SESSION_PREFIX = 8

export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value)
}

export function isArtifactSlug(value: string): boolean {
  return SLUG.test(value)
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function blobFile(root: string, sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error(`invalid artifact blob id: ${sha256}`)
  return join(root, 'blobs', sha256)
}

export function indexFile(root: string, sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return join(root, 'sessions', `${sessionId}.json`)
}

/** Null for anything missing, unreadable, or written in another format. */
export function parseIndex(text: string): SessionArtifactIndex | null {
  try {
    const value = JSON.parse(text) as Partial<SessionArtifactIndex>
    if (value?.format !== 1 && value?.format !== ARTIFACT_INDEX_FORMAT) return null
    if (typeof value.sessionId !== 'string' || !isSessionId(value.sessionId)) return null
    if (typeof value.sessionFile !== 'string' || !value.scan || !value.artifacts) return null
    return value as SessionArtifactIndex
  } catch {
    return null
  }
}

export function readIndex(root: string, sessionId: string): SessionArtifactIndex | null {
  try {
    return parseIndex(readFileSync(indexFile(root, sessionId), 'utf8'))
  } catch {
    return null
  }
}

/** Every readable index. A store that does not exist yet is simply empty. */
export function readAllIndexes(root: string): SessionArtifactIndex[] {
  let names: string[]
  try {
    names = readdirSync(join(root, 'sessions'))
  } catch {
    return []
  }
  const indexes: SessionArtifactIndex[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const index = readIndex(root, name.slice(0, -'.json'.length))
    if (index) indexes.push(index)
  }
  return indexes
}

/** The index a ref names: the exact session id, else a unique prefix of one. */
export function findIndex(
  root: string,
  session: string,
): SessionArtifactIndex | 'ambiguous' | null {
  const exact = readIndex(root, session)
  if (exact) return exact
  let names: string[]
  try {
    names = readdirSync(join(root, 'sessions'))
  } catch {
    return null
  }
  const matches = names.filter((name) => name.endsWith('.json') && name.startsWith(session))
  if (matches.length > 1) return 'ambiguous'
  const only = matches[0]
  return only ? readIndex(root, only.slice(0, -'.json'.length)) : null
}

export function readBlob(root: string, sha256: string): string | null {
  try {
    return readFileSync(blobFile(root, sha256), 'utf8')
  } catch {
    return null
  }
}

/** The version a reader sees: the newest one on the session's current branch. */
export function currentVersion(artifact: StoredArtifact): StoredArtifactVersion | undefined {
  let best: StoredArtifactVersion | undefined
  for (const version of artifact.versions) {
    if (version.onBranch && (!best || version.version >= best.version)) best = version
  }
  return best
}

/** One version on the current branch, by number. */
export function branchVersion(
  artifact: StoredArtifact,
  version: number,
): StoredArtifactVersion | undefined {
  return artifact.versions.find((v) => v.onBranch && v.version === version)
}

/**
 * A reference to an artifact in another session: `<sessionId>/<slug>`, with an
 * optional `@vN` (or `#vN`, the form chat links use). The session part may be
 * a unique prefix of at least MIN_SESSION_PREFIX characters.
 *
 * Returns null for a bare id: that keeps meaning "an artifact in this session".
 */
export interface ArtifactRef {
  session: string
  slug: string
  version?: number
}

export function parseArtifactRef(text: string): ArtifactRef | null {
  const match = /^\s*(?:artifact:\/\/)?([A-Za-z0-9-]+)\/([a-z0-9-]+)(?:[@#]v?(\d+))?\s*$/.exec(text)
  if (!match) return null
  const [, session, slug, version] = match
  if (!session || !slug || !isArtifactSlug(slug)) return null
  if (session.length < MIN_SESSION_PREFIX || !isSessionId(session)) return null
  return { session, slug, ...(version ? { version: Number(version) } : {}) }
}

export function formatArtifactRef(sessionId: string, slug: string): string {
  return `${sessionId}/${slug}`
}
