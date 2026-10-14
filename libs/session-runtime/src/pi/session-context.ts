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

export function parseSessionEntries(text: string, maxEntries = 200_000): SessionEntryLike[] | null {
  const entries: SessionEntryLike[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!value) continue
    if (!record(value)) return null
    entries.push(value)
    if (entries.length > maxEntries) return null
  }
  const header = entries[0]
  if (!header || header.type !== 'session' || typeof header.id !== 'string') return null
  const version = Number(header.version ?? 1)
  if (version < 2) {
    let previous: symbol | null = null
    for (const entry of entries) {
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
    for (const entry of entries) {
      if (entry.type === 'session') entry.version = 3
      if (entry.type === 'message' && record(entry.message) && entry.message.role === 'hookMessage')
        entry.message.role = 'custom'
    }
  }
  return entries
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

export function sessionContext(
  entries: SessionEntryLike[],
  maxMessages = 100_000,
): { messages: AgentMessage[] } | null {
  const index = new Map<unknown, SessionEntryLike>()
  let leaf: SessionEntryLike | undefined
  for (const entry of entries) {
    if (entry.type === 'session') continue
    index.set(entry.id, entry)
    leaf = entry
  }
  const path: SessionEntryLike[] = []
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
  const edits = new Map<unknown, SessionEntryLike>()
  for (const entry of context) if (entry.type === 'context_edit') edits.set(entry.targetId, entry)
  const messages: AgentMessage[] = []
  for (const [i, entry] of context.entries()) {
    if (entry.type === 'compaction' && i > 0) continue
    let projected = contextMessages(entry)
    if (!projected) return null
    const edit = edits.get(entry.id)
    if (edit) {
      if (edit.replacement === null) continue
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
    for (const value of projected) {
      if (!message(value)) return null
      messages.push(value)
      if (messages.length > maxMessages) return null
    }
  }
  return { messages }
}
