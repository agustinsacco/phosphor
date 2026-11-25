import type { AgentMessage } from '@phosphor/shared/rpc'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import {
  migrateLegacyRole,
  migrateSessionEntries,
  parseSessionLine,
  projectSessionEntry,
  SESSION_ENTRIES_MAX,
  sessionContextPlan,
  type SessionEntryLike,
} from '@phosphor/session-runtime/pi/session-context'
import { PI_MESSAGES_MAX } from '../pi-results'
import { PreviewRefused, readLine, scanLines, type LineRange } from './lines'

const INDEX_BYTES = 32 * 1024 * 1024
const PREVIEW_BYTES = 2 * HOST_LIMITS.outboundFrameBytes

type Indexed = SessionEntryLike & LineRange
// Preserve the object/null/invalid distinction pi checks, without retaining content.
function roleOnly(value: unknown) {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object' || Array.isArray(value)) return !!value
  return { role: 'role' in value ? value.role : undefined }
}

function indexTranscript(fd: number, size: number) {
  const entries: Indexed[] = []
  let bytes = 0
  scanLines(fd, size, (line, range) => {
    const entry = parseSessionLine(line)
    if (entry === undefined) return
    if (!entry) throw new PreviewRefused('parse')
    if (entries.length >= SESSION_ENTRIES_MAX) throw new PreviewRefused('index-limit')
    // Copy small fields, not slices into a potentially multi-MiB JSON string.
    const metadata = JSON.stringify({
      type: entry.type,
      id: entry.id,
      parentId: entry.parentId,
      version: entry.version,
      firstKeptEntryId: entry.firstKeptEntryId,
      firstKeptEntryIndex: entry.firstKeptEntryIndex,
      targetId: entry.targetId,
      message: roleOnly(entry.message),
      systemMessage: roleOnly(entry.systemMessage),
      replacement: roleOnly(entry.replacement),
      summary: !!entry.summary,
    })
    bytes += Buffer.byteLength(metadata)
    if (bytes > INDEX_BYTES) throw new PreviewRefused('index-limit')
    entries.push({ ...JSON.parse(metadata), ...range })
  })
  return entries
}

export type TranscriptPreview = { messages: AgentMessage[]; omitted?: true }

export function readPreview(fd: number, size: number): TranscriptPreview {
  const entries = indexTranscript(fd, size)
  const legacy = Number(entries[0]?.version ?? 1) < 3
  const migrated = migrateSessionEntries(entries)
  const plan = migrated && sessionContextPlan(migrated)
  if (!plan) throw new PreviewRefused('parse')
  const load = (range: Indexed) => {
    const entry = parseSessionLine(readLine(fd, range))
    if (!entry) throw new PreviewRefused('parse')
    if (legacy) migrateLegacyRole(entry)
    return entry
  }
  let bytes = 0
  const newest: AgentMessage[] = []
  for (const { entry, edit } of plan.reverse()) {
    // Ask the same projector whether these metadata shapes emit a message before
    // charging payload bytes. Deleted and non-message entries need no second read.
    const skeleton = projectSessionEntry(entry, edit)
    if (!skeleton) throw new PreviewRefused('parse')
    if (!skeleton.length) continue
    const cost = entry.length + (edit?.length ?? 0)
    if (newest.length === PI_MESSAGES_MAX || (newest.length && bytes + cost > PREVIEW_BYTES))
      return { messages: newest.reverse(), omitted: true }
    const projected = projectSessionEntry(load(entry), edit && load(edit))
    if (!projected) throw new PreviewRefused('parse')
    bytes += cost
    for (const message of projected.reverse()) {
      if (newest.length === PI_MESSAGES_MAX) return { messages: newest.reverse(), omitted: true }
      newest.push(message)
    }
  }
  return { messages: newest.reverse() }
}
