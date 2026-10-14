/**
 * Content helpers shared by the session scanner and the tree reader. These read
 * loosely-typed persisted JSONL entries, hence the `unknown` inputs and casts.
 */

/** Flatten a message's content into plain text, or undefined when empty. */
export function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content
      .filter((b) => (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join(' ')
      .trim()
    return text || undefined
  }
  return undefined
}
