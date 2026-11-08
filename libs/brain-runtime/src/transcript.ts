import { createReadStream } from 'node:fs'
import { JsonlDecoder } from '@phosphor/session-runtime/pi/jsonl'
import type { TranscriptSegment } from '@phosphor/memory-engine/types'

export interface LaneEntry {
  type?: string
  id?: string
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
