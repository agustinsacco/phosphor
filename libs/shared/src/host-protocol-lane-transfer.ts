/**
 * Moving a lane between machines and workspaces: the bundle manifest and the
 * `laneTransfer.*` call contract. A move copies a settled lane into a target
 * workspace; the source is never changed. Both ends validate everything here,
 * and every refusal is a fixed sentence, never free text from git or pi.
 */
import { parseLaneRuntimeFacts, type LaneRuntimeFacts } from './lane-transfer-runtime'
import { isLaneMarker } from './host-protocol-lane-marks'
import { isLaneBranchName } from './host-protocol/primitives'

export const LANE_TRANSFER_LIMITS = {
  /** Decoded bytes per `laneTransfer.read` / `laneTransfer.chunk`. */
  chunkBytes: 1024 * 1024,
  bundleBytes: 256 * 1024 * 1024,
  /** A Host indexes artifacts from at most this much transcript. */
  transcriptBytes: 32 * 1024 * 1024,
  attachmentBytes: 20 * 1024 * 1024,
  parts: 4000,
  /** An export or import left unfinished this long is discarded. */
  lifetimeMs: 60 * 60 * 1000,
  messages: 16,
} as const

export const LANE_PART_KINDS = [
  'transcript',
  'runs',
  'subagent',
  'claude-transcript',
  'claude-sidecar',
  'claude-prompt',
  'attachment',
] as const
export type LanePartKind = (typeof LANE_PART_KINDS)[number]

/** One file of a bundle. `path` is relative to its kind's root; `from` is an attachment's old path. */
export interface LanePart {
  kind: LanePartKind
  path: string
  size: number
  sha256: string
  from?: string
}

/** What git says about the source checkout. Absent when the folder is in no repository. */
export interface LaneGitFacts {
  /** Null when HEAD is detached. */
  branch: string | null
  commit: string
  /** Normalized origin (`host/owner/repo`), null without an origin. */
  origin: string | null
  /** Any tracked or untracked change, ignoring ignored files. */
  dirty: boolean
  /** Origin's branch tip is exactly `commit`. */
  pushed: boolean
  /** The branch is the repository's default branch. */
  trunk: boolean
  /** False when another checkout could not hold the same files (submodules, LFS). */
  portable: boolean
}

export interface LaneSourceFacts {
  runtime?: LaneRuntimeFacts
  sessionId: string
  title: string | null
  /** The source workspace's folder name. */
  workspace: string
  cwd: string
  git: LaneGitFacts | null
  /** Every part, transcript included. */
  bytes: number
  transcriptBytes: number
}

export interface LaneManifest {
  version: 1
  source: LaneSourceFacts
  fileName: string
  modifiedAt: number
  claude: { cliSessionId: string } | null
  parts: LanePart[]
}

/**
 * How the lane lands. `same-workspace`: the same repository, so the branch and
 * worktree are set up again at the same commit. `new-branch`: another
 * repository, where the lane gets a fresh branch off trunk and the code stays
 * behind. `folder`: a folder git does not track; the lane runs in it.
 */
export type LaneMoveMode = 'same-workspace' | 'new-branch' | 'folder'

export interface LaneTargetPlan {
  mode: LaneMoveMode
  branch: string | null
  workspace: string
  blockers: string[]
}

export interface LaneMoveNotice {
  from: string
  to: string
}

export interface LaneMoveMarks {
  pinned: boolean
  /** An explicit marker to set on the copy; null leaves it derived. */
  marker: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((k) => Object.hasOwn(v, k)) &&
  Object.keys(v).every((k) => required.includes(k) || optional.includes(k))
const size = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max
// eslint-disable-next-line no-control-regex
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
export const transferText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !controls.test(v)
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const absolute = (v: unknown): v is string =>
  transferText(v, 4096) && v.startsWith('/') && v.split('/').every((s) => s !== '.' && s !== '..')
export const isTransferId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{32}$/.test(v)
export const isSessionId = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
export const isTranscriptName = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9TZ:.-]{1,40}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(v)

/** A relative POSIX path with no empty, dot or dot-dot segment. */
export function isPartPath(v: unknown): v is string {
  return (
    transferText(v, 512) &&
    !v.startsWith('/') &&
    !v.includes('\\') &&
    v.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  )
}

function parsePart(v: unknown): LanePart | null {
  if (!isRecord(v) || !exact(v, ['kind', 'path', 'size', 'sha256'], ['from'])) return null
  const single =
    v.kind === 'transcript' || v.kind === 'claude-transcript' || v.kind === 'claude-prompt'
  if (
    !LANE_PART_KINDS.includes(v.kind as LanePartKind) ||
    !(single ? v.path === '' : isPartPath(v.path)) ||
    !size(v.size, LANE_TRANSFER_LIMITS.bundleBytes) ||
    !sha(v.sha256) ||
    (v.kind === 'attachment') !== (v.from !== undefined) ||
    (v.from !== undefined && !absolute(v.from)) ||
    (v.kind === 'attachment' && (v.size as number) > LANE_TRANSFER_LIMITS.attachmentBytes)
  )
    return null
  return {
    kind: v.kind as LanePartKind,
    path: v.path as string,
    size: v.size as number,
    sha256: v.sha256 as string,
    ...(v.from !== undefined ? { from: v.from as string } : {}),
  }
}

function parseGit(v: unknown): LaneGitFacts | null | undefined {
  if (v === null) return null
  if (
    !isRecord(v) ||
    !exact(v, ['branch', 'commit', 'origin', 'dirty', 'pushed', 'trunk', 'portable']) ||
    !(v.branch === null || isLaneBranchName(v.branch)) ||
    typeof v.commit !== 'string' ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(v.commit) ||
    !(v.origin === null || transferText(v.origin, 512)) ||
    typeof v.dirty !== 'boolean' ||
    typeof v.pushed !== 'boolean' ||
    typeof v.trunk !== 'boolean' ||
    typeof v.portable !== 'boolean'
  )
    return undefined
  return {
    branch: v.branch,
    commit: v.commit,
    origin: v.origin,
    dirty: v.dirty,
    pushed: v.pushed,
    trunk: v.trunk,
    portable: v.portable,
  }
}

export function parseLaneSourceFacts(v: unknown): LaneSourceFacts | null {
  if (
    !isRecord(v) ||
    !exact(
      v,
      ['sessionId', 'title', 'workspace', 'cwd', 'git', 'bytes', 'transcriptBytes'],
      ['runtime'],
    ) ||
    !isSessionId(v.sessionId) ||
    !(v.title === null || transferText(v.title, 200)) ||
    !transferText(v.workspace, 255) ||
    !absolute(v.cwd) ||
    !size(v.bytes, LANE_TRANSFER_LIMITS.bundleBytes) ||
    !size(v.transcriptBytes, v.bytes)
  )
    return null
  const git = parseGit(v.git)
  const runtime = v.runtime === undefined ? undefined : parseLaneRuntimeFacts(v.runtime)
  if (git === undefined || runtime === null) return null
  return {
    ...(runtime ? { runtime } : {}),
    sessionId: v.sessionId,
    title: v.title,
    workspace: v.workspace,
    cwd: v.cwd,
    git,
    bytes: v.bytes,
    transcriptBytes: v.transcriptBytes,
  }
}

export function parseLaneManifest(v: unknown): LaneManifest | null {
  if (
    !isRecord(v) ||
    !exact(v, ['version', 'source', 'fileName', 'modifiedAt', 'claude', 'parts']) ||
    v.version !== 1 ||
    !isTranscriptName(v.fileName) ||
    !size(v.modifiedAt) ||
    !Array.isArray(v.parts) ||
    v.parts.length === 0 ||
    v.parts.length > LANE_TRANSFER_LIMITS.parts
  )
    return null
  const source = parseLaneSourceFacts(v.source)
  let claude: LaneManifest['claude'] = null
  if (v.claude !== null) {
    if (
      !isRecord(v.claude) ||
      !exact(v.claude, ['cliSessionId']) ||
      !isSessionId(v.claude.cliSessionId)
    )
      return null
    claude = { cliSessionId: v.claude.cliSessionId }
  }
  const parts: LanePart[] = []
  const seen = new Set<string>()
  let bytes = 0
  for (const raw of v.parts) {
    const part = parsePart(raw)
    if (!part) return null
    const key = `${part.kind}:${part.path}`
    if (seen.has(key)) return null
    seen.add(key)
    bytes += part.size
    parts.push(part)
  }
  const transcripts = parts.filter((p) => p.kind === 'transcript')
  if (
    !source ||
    transcripts.length !== 1 ||
    transcripts[0]!.size !== source.transcriptBytes ||
    bytes !== source.bytes ||
    !v.fileName.endsWith(`_${source.sessionId}.jsonl`) ||
    (claude === null && parts.some((p) => p.kind.startsWith('claude-')))
  )
    return null
  return { version: 1, source, fileName: v.fileName, modifiedAt: v.modifiedAt, claude, parts }
}

export function parseLaneTargetPlan(v: unknown): LaneTargetPlan | null {
  if (
    !isRecord(v) ||
    !exact(v, ['mode', 'branch', 'workspace', 'blockers']) ||
    !['same-workspace', 'new-branch', 'folder'].includes(v.mode as string) ||
    !(v.branch === null || isLaneBranchName(v.branch)) ||
    !transferText(v.workspace, 255) ||
    !Array.isArray(v.blockers) ||
    v.blockers.length > LANE_TRANSFER_LIMITS.messages ||
    !v.blockers.every((b) => transferText(b, 300))
  )
    return null
  return {
    mode: v.mode as LaneMoveMode,
    branch: v.branch,
    workspace: v.workspace,
    blockers: v.blockers as string[],
  }
}

export function parseLaneMoveNotice(v: unknown): LaneMoveNotice | null {
  if (
    !isRecord(v) ||
    !exact(v, ['from', 'to']) ||
    !transferText(v.from, 80) ||
    !transferText(v.to, 80)
  )
    return null
  return { from: v.from, to: v.to }
}

export function parseLaneMoveMarks(v: unknown): LaneMoveMarks | null {
  if (
    !isRecord(v) ||
    !exact(v, ['pinned', 'marker']) ||
    typeof v.pinned !== 'boolean' ||
    !(v.marker === null || isLaneMarker(v.marker))
  )
    return null
  return { pinned: v.pinned, marker: v.marker }
}

/** A configured branch prefix: empty, or a branch-safe stem ending in a separator. */
export function isBranchPrefix(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    (v === '' || (isLaneBranchName(`${v}x`) && /^[A-Za-z0-9._/-]{1,40}$/.test(v)))
  )
}
