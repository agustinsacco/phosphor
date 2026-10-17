import { readFile } from 'node:fs/promises'
import type { SessionTree, SessionTreeEntry } from '@shared/ipc'
import { extractText } from './session-content'

/**
 * Read a persisted session file into the branch structure the tree view
 * renders: one entry per JSONL record, with previews and tool names.
 *
 * The file is pi's, so every value is checked before it is used. A line that
 * is not an object, or a row without a string `type` and `id`, is skipped; an
 * optional field of the wrong type is left out. A malformed row costs only
 * itself, never the rows around it or the leaf.
 */

type JsonRecord = Record<string, unknown>

/** Optional entry fields read straight off the row as strings. */
type OptionalStringField = Exclude<keyof SessionTreeEntry, 'id' | 'parentId' | 'type' | 'timestamp'>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function setIfString(node: SessionTreeEntry, field: OptionalStringField, value: unknown): void {
  if (typeof value === 'string') node[field] = value
}

function parseRecord(line: string): JsonRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  return isRecord(parsed) ? parsed : null
}

/** Content blocks that are objects, and whose text, on a text block, is a string. */
function contentBlocks(content: unknown[]): JsonRecord[] {
  return content.filter(
    (block): block is JsonRecord =>
      isRecord(block) && (block.type !== 'text' || typeof block.text === 'string'),
  )
}

function previewOf(content: unknown): string | undefined {
  return extractText(Array.isArray(content) ? contentBlocks(content) : content)?.slice(0, 160)
}

function readMessage(node: SessionTreeEntry, message: JsonRecord): void {
  const role = stringOrUndefined(message.role)
  if (role === undefined) return
  node.role = role
  if (role === 'user') {
    setIfString(node, 'preview', previewOf(message.content))
  } else if (role === 'assistant' && Array.isArray(message.content)) {
    const blocks = contentBlocks(message.content)
    setIfString(node, 'preview', previewOf(blocks))
    const tools = blocks.filter((block) => block.type === 'toolCall')
    if (tools.length > 0) {
      node.toolName = tools
        .map((tool) => tool.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .join(', ')
    }
  } else if (role === 'toolResult') {
    setIfString(node, 'toolName', message.toolName)
  }
}

function treeEntry(entry: JsonRecord, id: string, type: string): SessionTreeEntry {
  const node: SessionTreeEntry = {
    id,
    parentId: stringOrUndefined(entry.parentId) ?? null,
    type,
    timestamp: stringOrUndefined(entry.timestamp) ?? '',
  }

  if (type === 'message') {
    if (isRecord(entry.message)) readMessage(node, entry.message)
  } else if (type === 'label') {
    setIfString(node, 'targetId', entry.targetId)
    setIfString(node, 'label', entry.label)
  } else if (type === 'branch_summary' || type === 'compaction') {
    if (typeof entry.summary === 'string') node.summary = entry.summary.slice(0, 400)
  } else if (type === 'session_info') {
    setIfString(node, 'name', entry.name)
  } else if (type === 'model_change') {
    setIfString(node, 'provider', entry.provider)
    setIfString(node, 'modelId', entry.modelId)
  } else if (type === 'thinking_level_change') {
    setIfString(node, 'thinkingLevel', entry.thinkingLevel)
  }

  return node
}

export async function readSessionTree(path: string): Promise<SessionTree> {
  const raw = await readFile(path, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  const entries: SessionTreeEntry[] = []
  let sessionId = ''
  let cwd = ''
  let leafId: string | null = null

  for (const line of lines) {
    const entry = parseRecord(line)
    if (!entry || typeof entry.type !== 'string') continue
    if (entry.type === 'session') {
      sessionId = stringOrUndefined(entry.id) ?? ''
      cwd = stringOrUndefined(entry.cwd) ?? ''
      continue
    }
    const id = entry.id
    if (typeof id !== 'string' || !id) continue
    leafId = id
    entries.push(treeEntry(entry, id, entry.type))
  }

  return { sessionId, cwd, entries, leafId }
}
