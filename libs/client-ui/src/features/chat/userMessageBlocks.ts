import { parseListLine, type ListKind } from '@/lib/composerText'

/**
 * Blocks in a user message.
 *
 * The user bubble was `whitespace-pre-wrap`, so a list the composer helped you
 * write read back as literal `- ` characters. Full markdown is the wrong fix:
 * the bubble also carries the `<attached-files>` block, and a markdown renderer
 * either swallows it as HTML or needs a raw-HTML plugin the CSP rules out. So
 * only the thing the composer produces is promoted — lists — and everything
 * else stays exactly the text that was sent.
 */

export interface UserTextItem {
  content: string
  /** Nesting depth, 0 for a top-level item. */
  depth: number
  /** null when the item is not a task. */
  checked: boolean | null
}

export type UserTextBlock =
  | { kind: 'text'; text: string }
  | { kind: 'list'; listKind: ListKind; start: number; items: UserTextItem[] }

/** Split a sent message into plain-text runs and list runs. */
export function parseUserText(text: string): UserTextBlock[] {
  const blocks: UserTextBlock[] = []
  let plain: string[] = []

  const flushPlain = (): void => {
    if (plain.length === 0) return
    blocks.push({ kind: 'text', text: plain.join('\n') })
    plain = []
  }

  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const parsed = parseListLine(lines[i]!)
    if (!parsed) {
      plain.push(lines[i]!)
      i += 1
      continue
    }
    flushPlain()
    const listKind = parsed.kind
    const start = parsed.number ?? 1
    const items: UserTextItem[] = []
    // A run ends at the first line that is not an item of the same kind.
    while (i < lines.length) {
      const item = parseListLine(lines[i]!)
      if (!item || item.kind !== listKind) break
      items.push({
        content: item.content,
        depth: Math.floor(item.indent.length / 2),
        checked: item.task ? item.task.toLowerCase() === '[x]' : null,
      })
      i += 1
    }
    blocks.push({ kind: 'list', listKind, start, items })
  }

  flushPlain()
  return blocks
}
