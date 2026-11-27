/**
 * What a client sees of Brain Agent's conversation: user and assistant text only, newest page
 * first, paged backwards by a Host-issued cursor. Tool calls, tool output, thinking, paths and
 * pi's state never leave the Host.
 */
import type { HostBrainLanePage } from '@phosphor/shared/host-brain'
import type { AgentMessage } from '@phosphor/shared/rpc'

export type ConversationEntry = HostBrainLanePage['entries'][number]

/** The page shape's own bound. */
export const PAGE_ENTRIES = 40
/** Each entry is cut here; the result shape cuts at 8192 characters too. */
const ENTRY_CHARS = 8192
/** Well under a non-write result's frame. */
const PAGE_BYTES = 512 * 1024

function messageText(message: AgentMessage): string {
  if (message.role === 'user') {
    if (typeof message.content === 'string') return message.content
    return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
  }
  if (message.role === 'assistant')
    return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
  return ''
}

/** Settled messages as entries, then the reply in flight; ids follow the message index. */
export function conversationEntries(
  messages: readonly AgentMessage[],
  streaming: { turn: number; text: string } | null,
): ConversationEntry[] {
  const entries = messages.flatMap((message, index): ConversationEntry[] => {
    if (message.role !== 'user' && message.role !== 'assistant') return []
    const text = messageText(message).trim()
    return text ? [{ id: `m${index}`, role: message.role, text: text.slice(0, ENTRY_CHARS) }] : []
  })
  if (streaming?.text.trim())
    entries.push({
      id: `t${streaming.turn}`,
      role: 'assistant',
      text: streaming.text.trim().slice(0, ENTRY_CHARS),
    })
  return entries
}

/** A cursor names the entry before which the next older page ends; never a path. */
const CURSOR = /^b(\d{1,9})$/

export class ConversationCursorInvalid extends Error {
  constructor() {
    super('That conversation cursor is not this Host’s.')
  }
}

/** The page ending at `cursor` (the newest without one), bounded by count and bytes. */
export function conversationPage(
  entries: readonly ConversationEntry[],
  cursor: string | null,
): { entries: ConversationEntry[]; next: string | null } {
  let end = entries.length
  if (cursor !== null) {
    const found = CURSOR.exec(cursor)
    if (!found) throw new ConversationCursorInvalid()
    end = Math.min(Number(found[1]), entries.length)
  }
  let start = end
  let bytes = 0
  while (start > 0 && end - start < PAGE_ENTRIES) {
    const size = Buffer.byteLength(JSON.stringify(entries[start - 1]))
    if (bytes + size > PAGE_BYTES && start < end) break
    bytes += size
    start--
  }
  return { entries: entries.slice(start, end), next: start > 0 ? `b${start}` : null }
}
