import { isSessionId } from '@phosphor/shared/host-protocol-lane-transfer'
import { LANE_MOVED_TYPE } from './notice'

/** The only transcript format this code rewrites. Anything else is refused, not guessed. */
export const SESSION_FORMAT = 3

export interface TranscriptHeader {
  id: string
  cwd: string
  raw: Record<string, unknown>
}

/** pi's JSONL is strictly LF-framed; the header is everything before the first `\n`. */
export function splitTranscript(text: string): { header: string; rest: string } | null {
  const end = text.indexOf('\n')
  return end < 0 ? null : { header: text.slice(0, end), rest: text.slice(end + 1) }
}

export function parseHeader(line: string): TranscriptHeader | null {
  try {
    const raw = JSON.parse(line) as unknown
    if (
      raw === null ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      !('type' in raw) ||
      raw.type !== 'session' ||
      !('version' in raw) ||
      raw.version !== SESSION_FORMAT ||
      !('id' in raw) ||
      !isSessionId(raw.id) ||
      !('cwd' in raw) ||
      typeof raw.cwd !== 'string' ||
      !raw.cwd.startsWith('/')
    )
      return null
    return { id: raw.id, cwd: raw.cwd, raw: raw as Record<string, unknown> }
  } catch {
    return null
  }
}

interface Entry {
  type?: unknown
  id?: unknown
  name?: unknown
  provider?: unknown
  modelId?: unknown
  customType?: unknown
  details?: { attachments?: unknown }
  message?: { role?: unknown; content?: unknown }
}

function entries(rest: string): Entry[] {
  const out: Entry[] = []
  for (const line of rest.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value as Entry)
    } catch {
      // pi skips lines it cannot parse; so does this reader.
    }
  }
  return out
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) =>
      block &&
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block
        ? String(block.text)
        : '',
    )
    .join('\n')
}

export interface TranscriptFacts {
  title: string | null
  provider: string | null
  model: string | null
  /** The last entry's id: pi resumes there, so a note appended after it is the next message. */
  leafId: string | null
  /** Paths from `<attached-files>` blocks in user messages, first mention first. */
  attachments: string[]
}

/** What a move reads from a transcript body, without trusting any of it as a path to write. */
export function transcriptFacts(rest: string): TranscriptFacts {
  let title: string | null = null
  let provider: string | null = null
  let model: string | null = null
  let leafId: string | null = null
  const attachments = new Set<string>()
  for (const entry of entries(rest)) {
    if (
      entry.type === 'model_change' &&
      typeof entry.provider === 'string' &&
      typeof entry.modelId === 'string'
    ) {
      provider = entry.provider
      model = entry.modelId
    }
    if (typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 64)
      leafId = entry.id
    if (entry.type === 'session_info' && typeof entry.name === 'string') {
      const name = entry.name.trim()
      title = name || null
    }
    if (entry.type === 'custom_message' && entry.customType === LANE_MOVED_TYPE) {
      const moved = entry.details?.attachments
      if (Array.isArray(moved))
        for (const mapping of moved) {
          if (!mapping || typeof mapping !== 'object') continue
          const { from, to } = mapping as { from?: unknown; to?: unknown }
          if (
            typeof from !== 'string' ||
            typeof to !== 'string' ||
            !to.startsWith('/') ||
            to.length > 4096
          )
            continue
          attachments.delete(from)
          attachments.add(to)
        }
    }
    if (entry.type !== 'message' || entry.message?.role !== 'user') continue
    for (const block of userText(entry.message.content).matchAll(
      /<attached-files>\n([\s\S]*?)\n<\/attached-files>/g,
    ))
      for (const path of block[1]!.split('\n'))
        if (path.startsWith('/') && path.length <= 4096) attachments.add(path)
  }
  return { title, provider, model, leafId, attachments: [...attachments] }
}
