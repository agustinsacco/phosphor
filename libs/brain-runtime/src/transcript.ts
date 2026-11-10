import { createReadStream } from 'node:fs'
import { JsonlDecoder } from '@phosphor/session-runtime/pi/jsonl'
import type { TranscriptSegment } from '@phosphor/memory-engine/types'

export interface LaneEntry {
  type?: string
  id?: string
  parentId?: string | null
  cwd?: string
  timestamp?: string | number
  provider?: string
  modelId?: string
  thinkingLevel?: string
  summary?: string
  content?: string | ContentBlock[]
  message?: {
    role?: string
    provider?: string
    model?: string
    toolName?: string
    content?: string | ContentBlock[]
  }
}
interface ContentBlock {
  type: string
  text?: string
  name?: string
  arguments?: unknown
}

/** Strict LF framing also preserves Unicode separators inside message text. */
export async function readEntries(path: string): Promise<LaneEntry[]> {
  const entries: LaneEntry[] = []
  const decoder = new JsonlDecoder()
  const append = (lines: string[]): void => {
    for (const line of lines) {
      try {
        const entry: unknown = JSON.parse(line)
        if (entry && typeof entry === 'object' && !Array.isArray(entry))
          entries.push(entry as LaneEntry)
      } catch {
        // A live lane may still be writing its final record.
      }
    }
  }
  for await (const chunk of createReadStream(path)) append(decoder.push(chunk as Buffer))
  append(decoder.end())
  return entries
}

export function transcriptSegments(entries: LaneEntry[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  for (const entry of entries) {
    const at = new Date(entry.timestamp ?? 0).getTime()
    const observedAt = Number.isFinite(at) ? at : 0
    const date = new Date(observedAt).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const add = (role: TranscriptSegment['role'], label: string, text: string): void => {
      if (text.trim())
        segments.push({
          entryId: entry.id ?? '',
          role,
          label: `${label} · ${date}`,
          observedAt,
          text,
        })
    }
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      add('context', 'Summary', entry.summary ?? '')
      continue
    }
    const message =
      entry.type === 'custom_message' ? { role: 'custom', content: entry.content } : entry.message
    if (!message) continue
    const role = message.role
    if (role === 'toolResult' && ['brain_search', 'brain_related'].includes(message.toolName ?? ''))
      continue
    const content =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : (message.content ?? [])
    const text = content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
    if (role === 'user') add('user', 'You', text)
    else if (role === 'assistant') {
      add('assistant', 'Agent', text)
      for (const block of content) {
        if (block.type === 'toolCall')
          add(
            'assistant',
            `Agent · ${block.name ?? 'tool'} call`,
            JSON.stringify(block.arguments ?? {}),
          )
      }
    } else if (role === 'toolResult')
      add('toolResult', `Tool output · ${message.toolName ?? 'tool'}`, text)
    else if (role === 'custom') add('context', 'Context', text)
  }
  return segments
}

/** Follow the clone point's ancestry when present; legacy flat lanes retain file order. */
export function transcriptAtLeaf(entries: LaneEntry[], leafId: string | null): LaneEntry[] {
  const end = entries.findIndex((entry) => entry.id === leafId)
  if (end < 0) return []
  const prefix = entries.slice(0, end + 1)
  if (!prefix.some((entry) => entry.parentId !== undefined)) return prefix
  const byId = new Map(prefix.filter((entry) => entry.id).map((entry) => [entry.id, entry]))
  const path: LaneEntry[] = []
  const seen = new Set<string>()
  let id = leafId
  while (id && !seen.has(id)) {
    seen.add(id)
    const entry = byId.get(id)
    if (!entry) break
    path.push(entry)
    id = entry.parentId ?? null
  }
  return path.reverse()
}
