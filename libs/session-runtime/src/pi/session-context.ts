/** Mirrors pi 0.87.1: loadEntriesFromFile, migrateToCurrentVersion (v1/v2/v3),
 * _buildIndex, buildSessionPath, buildContextEntries, buildSessionProjection,
 * sessionEntryToContextMessages and the message constructors in core/messages.js.
 * Disk shapes stay loose, like pi's loader. This reader never repairs or rewrites files.
 */
import type { AgentMessage } from '@phosphor/shared/rpc'

export type SessionEntryLike = Record<string, unknown>
const record = (value: unknown): value is SessionEntryLike =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const message = (value: unknown): value is AgentMessage & SessionEntryLike =>
  record(value) && typeof value.role === 'string'

export function parseSessionLine(line: string): SessionEntryLike | null | undefined {
  if (!line.trim()) return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  return !value ? undefined : record(value) ? value : null
}

export const SESSION_ENTRIES_MAX = 200_000
/** The largest session file a reader opens: the stopped preview and resume's provider check. */
export const TRANSCRIPT_FILE_MAX_BYTES = 2 * 1024 ** 3
export function parseSessionEntries(
  text: string,
  maxEntries = SESSION_ENTRIES_MAX,
): SessionEntryLike[] | null {
  const entries: SessionEntryLike[] = []
  for (const line of text.split('\n')) {
    const entry = parseSessionLine(line)
    if (entry === undefined) continue
    if (!entry || entries.length >= maxEntries) return null
    entries.push(entry)
  }
  return migrateSessionEntries(entries)
}

export function migrateSessionEntries<T extends SessionEntryLike>(entries: T[]): T[] | null {
  const header = entries[0]
  if (!header || header.type !== 'session' || typeof header.id !== 'string') return null
  const version = Number(header.version ?? 1)
  if (version < 2) {
    let previous: symbol | null = null
    for (const item of entries) {
      const entry: SessionEntryLike = item
      if (entry.type === 'session') continue
      // Internal symbols keep fresh migration ids distinct from all references in the file.
      const id = Symbol()
      entry.id = id
      entry.parentId = previous
      previous = id
      if (entry.type === 'compaction' && typeof entry.firstKeptEntryIndex === 'number') {
        const target = entries[entry.firstKeptEntryIndex]
        if (target && target.type !== 'session') entry.firstKeptEntryId = target.id
        delete entry.firstKeptEntryIndex
      }
    }
  }
  if (version < 3) {
    for (const entry of entries) migrateLegacyRole(entry)
  }
  return entries
}

export function migrateLegacyRole(entry: SessionEntryLike) {
  if (entry.type === 'session') entry.version = 3
  if (entry.type === 'message' && record(entry.message) && entry.message.role === 'hookMessage')
    entry.message.role = 'custom'
}

function contextMessages(entry: SessionEntryLike): unknown[] | null {
  if (entry.type === 'message') {
    if (!record(entry.message)) return null
    const value = entry.message
    if (value.content == null) {
      if (value.role === 'system') return [{ ...value, content: '' }]
      if (['user', 'assistant', 'toolResult'].includes(String(value.role)))
        return [{ ...value, content: [] }]
    }
    return [value]
  }
  // pi's message constructors run new Date(timestamp) on the raw JSON value, and only
  // for the entries below: an entry pi ignores never has its timestamp converted.
  const timestamp = () => new Date(entry.timestamp as string | number).getTime()
  if (entry.type === 'custom_message')
    return [
      {
        role: 'custom',
        customType: entry.customType,
        content: entry.content ?? [],
        display: entry.display,
        details: entry.details,
        timestamp: timestamp(),
      },
    ]
  if (entry.type === 'branch_summary' && entry.summary)
    return [
      {
        role: 'branchSummary',
        summary: entry.summary,
        fromId: entry.fromId,
        timestamp: timestamp(),
      },
    ]
  if (entry.type === 'compaction') {
    const summary = {
      role: 'compactionSummary',
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: timestamp(),
    }
    return entry.systemMessage ? [entry.systemMessage, summary] : [summary]
  }
  return []
}

export function sessionContextPlan<T extends SessionEntryLike>(entries: T[]) {
  const index = new Map<unknown, T>()
  let leaf: T | undefined
  for (const entry of entries) {
    if (entry.type === 'session') continue
    index.set(entry.id, entry)
    leaf = entry
  }
  const path: T[] = []
  const seen = new Set<unknown>()
  while (leaf) {
    if (seen.has(leaf.id)) return null
    seen.add(leaf.id)
    path.push(leaf)
    leaf = leaf.parentId ? index.get(leaf.parentId) : undefined
  }
  path.reverse()
  let compactionIndex = -1
  for (const [i, entry] of path.entries()) if (entry.type === 'compaction') compactionIndex = i
  const compaction = path[compactionIndex]
  let context = path
  if (compaction) {
    context = [compaction]
    let kept = false
    for (const entry of path.slice(0, compactionIndex)) {
      if (entry.id === compaction.firstKeptEntryId) kept = true
      if (
        kept &&
        !(entry.type === 'message' && record(entry.message) && entry.message.role === 'system')
      )
        context.push(entry)
    }
    for (const entry of path.slice(compactionIndex + 1)) context.push(entry)
  }
  const edits = new Map<unknown, T>()
  for (const entry of context) if (entry.type === 'context_edit') edits.set(entry.targetId, entry)
  return context.flatMap((entry, i) =>
    entry.type === 'compaction' && i > 0 ? [] : [{ entry, edit: edits.get(entry.id) }],
  )
}

export function projectSessionEntry(
  entry: SessionEntryLike,
  edit?: SessionEntryLike,
): AgentMessage[] | null {
  let projected = contextMessages(entry)
  if (!projected) return null
  if (edit) {
    if (edit.replacement === null) return []
    if (!record(edit.replacement)) return null
    const replacement = edit.replacement
    projected = projected.map((value) => {
      if (
        !record(value) ||
        !['user', 'assistant', 'toolResult', 'custom'].includes(String(value.role))
      )
        return value
      const content =
        (value.role === 'assistant' || value.role === 'toolResult') &&
        typeof replacement.content === 'string'
          ? [{ type: 'text', text: replacement.content }]
          : replacement.content
      return { ...value, content }
    })
  }
  return projected.every(message) ? projected : null
}

export function sessionContext(
  entries: SessionEntryLike[],
  maxMessages = 100_000,
): { messages: AgentMessage[] } | null {
  const plan = sessionContextPlan(entries)
  if (!plan) return null
  const messages: AgentMessage[] = []
  for (const { entry, edit } of plan) {
    const projected = projectSessionEntry(entry, edit)
    if (!projected || messages.length + projected.length > maxMessages) return null
    messages.push(...projected)
  }
  return { messages }
}
