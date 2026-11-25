/**
 * pi transcripts larger than any whole-file read allows: a session header, a
 * `model_change` at the start, then `bulkMiB` lines of 1 MiB each. Callers
 * append their own last entries.
 */
import { appendFileSync, closeSync, openSync, writeSync } from 'node:fs'

const PAD = 'x'.repeat(1024 * 1024 - 160)
const line = (value: unknown) => `${JSON.stringify(value)}\n`

/**
 * `chained`: user messages `u1..u<bulkMiB>` linked by parentId from `m0`.
 * `legacy`: a version 1 file, whose entries have no ids and chain in file order.
 * `torn`: unparseable lines and blank lines, which pi's loader skips.
 */
export type LargeTranscriptBulk = 'chained' | 'legacy' | 'torn'

function bulkLine(bulk: LargeTranscriptBulk, index: number): string {
  if (bulk === 'torn') return `{"torn":"${PAD}\n\n`
  const message = { role: 'user', content: [{ type: 'text', text: PAD }] }
  if (bulk === 'legacy') return line({ type: 'message', message })
  return line({
    type: 'message',
    id: `u${index}`,
    parentId: index === 1 ? 'm0' : `u${index - 1}`,
    message,
  })
}

/** Writes the bulk after a first model `m0` from `first-provider`. */
export function writeLargeTranscript(
  path: string,
  bulkMiB: number,
  bulk: LargeTranscriptBulk = 'chained',
): void {
  const fd = openSync(path, 'w', 0o600)
  try {
    const version = bulk === 'legacy' ? 1 : 3
    writeSync(fd, line({ type: 'session', version, id: 'large', cwd: '/repo' }))
    writeSync(
      fd,
      line({ type: 'model_change', id: 'm0', parentId: null, provider: 'first-provider' }),
    )
    for (let index = 1; index <= bulkMiB; index++) writeSync(fd, bulkLine(bulk, index))
  } finally {
    closeSync(fd)
  }
}

export function appendEntries(path: string, entries: readonly unknown[]): void {
  appendFileSync(path, entries.map(line).join(''))
}

export const assistantEntry = (id: string, parentId: string, provider: string) => ({
  type: 'message',
  id,
  parentId,
  message: { role: 'assistant', content: [], provider, model: 'm' },
})
