/**
 * pi transcripts larger than any whole-file read allows: a session header, a
 * `model_change` at the start, then `bulkMiB` user messages of 1 MiB each,
 * chained from it. Callers append their own last entries.
 */
import { appendFileSync, closeSync, openSync, writeSync } from 'node:fs'

const PAD = 'x'.repeat(1024 * 1024 - 160)
const line = (value: unknown) => `${JSON.stringify(value)}\n`

/** Writes the bulk, whose last entry is `u<bulkMiB>`; its first model is `first-provider`. */
export function writeLargeTranscript(path: string, bulkMiB: number): void {
  const fd = openSync(path, 'w', 0o600)
  try {
    writeSync(fd, line({ type: 'session', version: 3, id: 'large', cwd: '/repo' }))
    writeSync(
      fd,
      line({ type: 'model_change', id: 'm0', parentId: null, provider: 'first-provider' }),
    )
    for (let index = 1; index <= bulkMiB; index++) {
      const parentId = index === 1 ? 'm0' : `u${index - 1}`
      const message = { role: 'user', content: [{ type: 'text', text: PAD }] }
      writeSync(fd, line({ type: 'message', id: `u${index}`, parentId, message }))
    }
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
