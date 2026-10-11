import { randomBytes } from 'node:crypto'
import { access, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  ARTIFACT_INDEX_FORMAT,
  ARTIFACT_ENTRY_TYPE,
  ARTIFACT_TYPES,
  ARTIFACT_WRITE_TOOLS,
  blobFile,
  contentHash,
  indexFile,
  type SessionArtifactIndex,
  type StoredArtifact,
  type StoredArtifactType,
} from '@phosphor/pi-extensions/artifact-store'
import { readLinesFrom, readSignature } from '../pi/session-fold'
import { extractText } from '../pi/session-content'

/**
 * Reads a pi session file into its artifact index, writing each distinct
 * version's content to the store as it goes.
 *
 * The session file stays the source of truth. This is a projection of it that
 * outlives what the renderer can see: pi's `get_messages` returns only the
 * context since the last compaction, and the session file itself goes when the
 * session is deleted. Every artifact version on EVERY branch is kept, keyed by
 * tool call, with `onBranch` saying which ones the session currently shows.
 *
 * Incremental for the same reason the session scanner is: pi appends at the
 * end of every turn, and re-reading a 20 MB file per turn is O(n²) over a
 * session's life. Only lines that can matter are parsed at all.
 */

/**
 * pi writes every entry as `{"type":…,"id":…,"parentId":…,…}`. Reading the ids
 * off the front of the line keeps the branch walk from parsing the 99% of
 * lines that carry no artifact. Anything that does not match is parsed.
 */
const ENTRY_HEAD = /^\{"type":"([^"]+)","id":"([^"]+)","parentId":(?:null|"([^"]*)")/

/** Ids longer than this were never written by the artifact tools. */
const MAX_ID_LENGTH = 200

interface Candidate {
  slug: string
  title?: string
  type?: string
  language?: string
  version: number
  content: string
  toolCallId: string
  entryId: string
  createdAt: string
}

export interface ScanState {
  header?: { id?: string; cwd?: string; timestamp?: string; parentSession?: string }
  name?: string
  firstUserText?: string
  parents: Map<string, string | null>
  lastId?: string
  candidates: Candidate[]
}

function tryParse(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Exported for tests: what one line contributes. */
export function scanLine(state: ScanState, line: string): void {
  let parsed: Record<string, unknown> | undefined
  let type: unknown
  let id: unknown
  let parentId: string | null
  const head = ENTRY_HEAD.exec(line)
  if (head) {
    type = head[1]
    id = head[2]
    parentId = head[3] ?? null
  } else {
    parsed = tryParse(line)
    if (!parsed) return
    type = parsed.type
    id = parsed.id
    parentId = typeof parsed.parentId === 'string' ? parsed.parentId : null
  }

  if (type === 'session') {
    parsed ??= tryParse(line)
    state.header = parsed as ScanState['header']
    return
  }
  if (typeof id !== 'string') return
  state.parents.set(id, parentId)
  state.lastId = id

  if (type === 'session_info') {
    parsed ??= tryParse(line)
    const name = parsed?.name
    state.name = typeof name === 'string' && name ? name : undefined
    return
  }
  const saved = type === 'custom' && line.includes(ARTIFACT_ENTRY_TYPE)
  if (type !== 'message' && !saved) return

  if (!state.firstUserText && line.includes('"role":"user"')) {
    parsed ??= tryParse(line)
    const message = parsed?.message as { role?: string; content?: unknown } | undefined
    if (message?.role === 'user') state.firstUserText = extractText(message.content)?.slice(0, 200)
  }

  if (!saved && !line.includes('"toolName":"artifact_')) return
  parsed ??= tryParse(line)
  if (saved && parsed?.customType !== ARTIFACT_ENTRY_TYPE) return
  const message = (
    saved
      ? { role: 'toolResult', toolName: 'artifact_create', details: parsed?.data }
      : parsed?.message
  ) as
    | {
        role?: string
        toolName?: string
        toolCallId?: string
        isError?: boolean
        timestamp?: number
        details?: Record<string, unknown>
      }
    | undefined
  if (message?.role !== 'toolResult' || message.isError) return
  if (!ARTIFACT_WRITE_TOOLS.includes(message.toolName ?? '')) return
  const details = message.details
  const slug = details?.id
  if (typeof slug !== 'string' || !slug || slug.length > MAX_ID_LENGTH) return
  if (typeof details?.content !== 'string' || typeof details.version !== 'number') return
  const timestamp = parsed?.timestamp
  state.candidates.push({
    slug,
    title: typeof details.title === 'string' ? details.title : undefined,
    type: typeof details.type === 'string' ? details.type : undefined,
    language: typeof details.language === 'string' ? details.language : undefined,
    version: details.version,
    content: details.content,
    // A tool call id is unique per call; the entry id stands in if one is ever missing.
    toolCallId:
      typeof message.toolCallId === 'string' && message.toolCallId
        ? message.toolCallId
        : `entry:${id}`,
    entryId: id,
    createdAt:
      typeof timestamp === 'string'
        ? timestamp
        : new Date(typeof message.timestamp === 'number' ? message.timestamp : 0).toISOString(),
  })
}

export function emptyScan(): ScanState {
  return { parents: new Map(), candidates: [] }
}

/** Entry ids from `leaf` back to the root, through the parents known here. */
function walkBranch(
  parents: Map<string, string | null>,
  leaf: string | undefined,
): { path: Set<string>; stop: string | null } {
  const path = new Set<string>()
  let cursor: string | null = leaf ?? null
  while (cursor !== null && parents.has(cursor) && !path.has(cursor)) {
    path.add(cursor)
    cursor = parents.get(cursor) ?? null
  }
  return { path, stop: cursor }
}

function normalizeType(type: string | undefined, fallback: StoredArtifactType): StoredArtifactType {
  // `artifact_update` used to send the `'update'` sentinel; never keep it.
  return (ARTIFACT_TYPES as readonly string[]).includes(type ?? '')
    ? (type as StoredArtifactType)
    : fallback
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Temp file then rename: a reader (pi, another window) never sees half a file. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temporary, data)
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function writeBlob(root: string, content: string): Promise<string> {
  const sha256 = contentHash(content)
  const path = blobFile(root, sha256)
  if (!(await exists(path))) await writeFileAtomic(path, content)
  return sha256
}

export async function writeIndex(root: string, index: SessionArtifactIndex): Promise<void> {
  await writeFileAtomic(indexFile(root, index.sessionId), JSON.stringify(index))
}

function cloneArtifacts(artifacts: Record<string, StoredArtifact>): Record<string, StoredArtifact> {
  const copy: Record<string, StoredArtifact> = {}
  for (const [slug, artifact] of Object.entries(artifacts)) {
    copy[slug] = { ...artifact, versions: artifact.versions.map((v) => ({ ...v })) }
  }
  return copy
}

/**
 * Bring `previous` up to date with the file at `path`.
 *
 * Returns `previous` itself when nothing changed (callers skip the write), a
 * new index otherwise, and null when the file is missing or is not a session.
 */
export async function indexSessionFile(
  root: string,
  path: string,
  previous: SessionArtifactIndex | null,
): Promise<SessionArtifactIndex | null> {
  let info: { size: number; mtimeMs: number }
  try {
    info = await stat(path)
  } catch {
    return null
  }

  const resumable =
    previous !== null &&
    previous.format === ARTIFACT_INDEX_FORMAT &&
    previous.sessionFile === path &&
    info.size >= previous.scan.offset &&
    (await readSignature(path, previous.scan.offset)) === previous.scan.signature
  if (resumable && info.size === previous.scan.offset && !previous.deleted) return previous

  const state = emptyScan()
  const offset = await readLinesFrom(path, resumable ? previous.scan.offset : 0, (line) =>
    scanLine(state, line),
  )

  let onBranch: Set<string>
  if (resumable) {
    const { path: walked, stop } = walkBranch(state.parents, state.lastId)
    // Appends that only extend the old leaf keep every old flag. Anything else
    // (a branch jump, a new root) moved the branch under old versions too.
    if (state.lastId && stop !== previous.scan.leafId) return indexSessionFile(root, path, null)
    onBranch = walked
  } else {
    if (!state.header?.id) return null
    onBranch = walkBranch(state.parents, state.lastId).path
  }

  const artifacts = resumable ? cloneArtifacts(previous.artifacts) : {}
  for (const candidate of state.candidates) {
    const existing = artifacts[candidate.slug]
    if (existing?.versions.some((v) => v.toolCallId === candidate.toolCallId)) continue
    const sha256 = await writeBlob(root, candidate.content)
    const artifact: StoredArtifact = existing ?? {
      slug: candidate.slug,
      title: candidate.title ?? candidate.slug,
      type: normalizeType(candidate.type, 'code'),
      versions: [],
    }
    artifact.title = candidate.title ?? artifact.title
    artifact.type = normalizeType(candidate.type, artifact.type)
    artifact.language = candidate.language ?? artifact.language
    artifact.versions.push({
      version: candidate.version,
      toolCallId: candidate.toolCallId,
      entryId: candidate.entryId,
      sha256,
      bytes: Buffer.byteLength(candidate.content, 'utf8'),
      createdAt: candidate.createdAt,
      title: candidate.title ?? artifact.title,
      onBranch: onBranch.has(candidate.entryId),
    })
    artifacts[candidate.slug] = artifact
  }

  const header = resumable ? undefined : state.header
  return {
    format: ARTIFACT_INDEX_FORMAT,
    sessionId: header?.id ?? previous!.sessionId,
    sessionFile: path,
    cwd: header?.cwd ?? previous?.cwd ?? '',
    createdAt: header?.timestamp ?? previous?.createdAt,
    parentSession: header?.parentSession ?? previous?.parentSession,
    name: state.name ?? (resumable ? previous.name : undefined),
    firstUserText: (resumable ? previous.firstUserText : undefined) ?? state.firstUserText,
    // The file is here, so the session is not deleted (it may be back from the trash).
    deleted: false,
    scan: {
      offset,
      size: info.size,
      mtimeMs: info.mtimeMs,
      signature: (await readSignature(path, offset)) ?? '',
      leafId: state.lastId ?? (resumable ? previous.scan.leafId : null),
    },
    artifacts,
  }
}
