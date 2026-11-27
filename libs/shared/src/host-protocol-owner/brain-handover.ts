/**
 * `owner.brainHandover.*`: This Mac's Desktop Brain moving once to its local Phosphor service.
 * Owner-only calls on the local socket; the service creates the private staging folder, the
 * owner fills it with allowlisted files and their hashes, and the service verifies sealed copies
 * before it publishes them. No call names a path the service then reads.
 * Reached through `../host-protocol-owner`. Living contract: docs/brain-handover.md.
 */
import { isSha256Hex, isUuid, isVersion } from '../control-api'
import { integer, record, text } from '../host-protocol/primitives'

export const BRAIN_HANDOVER_LIMITS = {
  files: 256,
  nameChars: 300,
  generationChars: 200,
  /** The staged Brain database. */
  databaseBytes: 8 * 1024 * 1024 * 1024,
  /** One Brain Agent transcript (OWNER_LIMITS.transcriptFileBytes). */
  transcriptBytes: 2 * 1024 * 1024 * 1024,
  rulesBytes: 1024 * 1024,
  modelFileBytes: 1024 * 1024 * 1024,
} as const

export type BrainHandoverState =
  'none' | 'staged' | 'verified' | 'published' | 'committed' | 'aborted'

/** Whether the service could run this Brain's reader; anything but `qualified` defers a move. */
export type BrainReaderReadiness = 'qualified' | 'unqualified' | 'unavailable'

export interface BrainHandoverSupport {
  /** This local service fences its native Brain until the durable owner is selected. */
  readonly ownerSelection?: 1
  /** The service can stage, verify and bind a Brain Agent conversation. */
  readonly handover: boolean
  readonly reader: BrainReaderReadiness
  /** `occupied`: the service already has a Brain; a move never merges or replaces it. */
  readonly target: 'empty' | 'occupied' | 'claimed'
}

export interface BrainHandoverFile {
  /** `brain.sqlite`, `AGENTS.md`, `transcripts/<file>.jsonl` or `embeddings/<model file>`. */
  readonly name: string
  readonly bytes: number
  readonly sha256: string
}

export interface BrainHandoverReport {
  readonly schema: { readonly from: number; readonly to: number }
  readonly counts: Readonly<Record<string, number>>
  /** Lanes the Brain read: still on the service, or kept as history. */
  readonly sources: { readonly lanes: number; readonly mapped: number; readonly missing: number }
  /** `active`: a transcript the Host's Brain lane resumes, as Desktop would have. */
  readonly agent: {
    readonly transcripts: number
    readonly rules: boolean
    readonly active: boolean
  }
  readonly model: 'moved' | 'download-needed'
}

export interface BrainHandoverBegin {
  readonly migrationId: string
  readonly sourceSchema: 7 | 8
  readonly sourceGeneration: string
  readonly desktopVersion: string
}

const NAME_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/

/** A relative allowlisted name: no absolute path, `..`, empty or hidden segment. */
export function isBrainHandoverName(v: unknown): v is string {
  if (!text(v, BRAIN_HANDOVER_LIMITS.nameChars)) return false
  const parts = v.split('/')
  if (parts.length > 5 || !parts.every((part) => NAME_SEGMENT.test(part))) return false
  if (parts.length === 1) return v === 'brain.sqlite' || v === 'AGENTS.md'
  if (parts[0] === 'transcripts') return parts.length === 2 && v.endsWith('.jsonl')
  return parts[0] === 'embeddings'
}

export const brainHandoverStatusParams = (v: unknown): { migrationId?: string } | null => {
  if (v === undefined || (record(v) && v.migrationId === undefined)) return {}
  return record(v) && isUuid(v.migrationId) ? { migrationId: v.migrationId } : null
}

export function brainHandoverBeginParams(v: unknown): BrainHandoverBegin | null {
  if (
    !record(v) ||
    !isUuid(v.migrationId) ||
    (v.sourceSchema !== 7 && v.sourceSchema !== 8) ||
    !text(v.sourceGeneration, BRAIN_HANDOVER_LIMITS.generationChars) ||
    !isVersion(v.desktopVersion)
  )
    return null
  return {
    migrationId: v.migrationId,
    sourceSchema: v.sourceSchema,
    sourceGeneration: v.sourceGeneration,
    desktopVersion: v.desktopVersion,
  }
}

function file(v: unknown): BrainHandoverFile | null {
  if (!record(v) || !isBrainHandoverName(v.name) || !isSha256Hex(v.sha256)) return null
  if (!integer(v.bytes) || v.bytes > BRAIN_HANDOVER_LIMITS.databaseBytes) return null
  return { name: v.name, bytes: v.bytes, sha256: v.sha256 }
}

export interface BrainHandoverVerify {
  readonly migrationId: string
  readonly files: readonly BrainHandoverFile[]
  /**
   * The staged transcript Desktop's Brain lane resumes next (`transcripts/<file>.jsonl`), or
   * null when it has none. Required: the Host never guesses which conversation continues.
   */
  readonly activeTranscript: string | null
}

export function brainHandoverVerifyParams(v: unknown): BrainHandoverVerify | null {
  if (!record(v) || !isUuid(v.migrationId) || !Array.isArray(v.files)) return null
  if (v.files.length === 0 || v.files.length > BRAIN_HANDOVER_LIMITS.files) return null
  const files: BrainHandoverFile[] = []
  for (const raw of v.files as unknown[]) {
    const parsed = file(raw)
    if (!parsed) return null
    files.push(parsed)
  }
  if (new Set(files.map((f) => f.name)).size !== files.length) return null
  if (!files.some((f) => f.name === 'brain.sqlite')) return null
  const active = v.activeTranscript
  if (
    active !== null &&
    (typeof active !== 'string' ||
      !active.startsWith('transcripts/') ||
      !files.some((f) => f.name === active))
  )
    return null
  return { migrationId: v.migrationId, files, activeTranscript: active }
}
