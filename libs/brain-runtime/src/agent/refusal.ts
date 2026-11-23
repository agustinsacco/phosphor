import { scrubExcerpt } from '@phosphor/memory-engine/secrets'
import { BRAIN_REASON_MAX } from '@phosphor/shared/brain-agent'

/** Two or more path segments, POSIX or Windows: a location never leaves Brain. */
const PATH = /(?:[A-Za-z]:)?(?:[\\/][^\s\\/'"`]+){2,}[\\/]?/g

/**
 * What Brain Agent may read of a failure: the first line of the message, secrets scrubbed, paths
 * replaced, at most 300 characters. Never a stack, a path or a token.
 */
export function plainRefusal(error: unknown, fallback = 'Brain could not do that.'): string {
  const message = error instanceof Error ? error.message : ''
  const line = scrubExcerpt(message.split(/\r?\n/, 1)[0] ?? '')
    .replace(PATH, 'a file')
    .replace(/\s+/g, ' ')
    .trim()
  return line.slice(0, BRAIN_REASON_MAX) || fallback
}
