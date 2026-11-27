import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const events: string[] = []
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    stat: vi.fn(async (...args: Parameters<typeof fs.stat>) => {
      events.push('tail')
      return fs.stat(...args)
    }),
    appendFile: vi.fn(async (...args: Parameters<typeof fs.appendFile>) => {
      events.push('append')
      return fs.appendFile(...args)
    }),
  }
})
const { appendSessionName } = await import('./session-writer')

let dir: string
beforeEach(async () => {
  events.length = 0
  dir = await mkdtemp(join(tmpdir(), 'writer-order-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

it('checks permission last, right before the append, after every read', async () => {
  const file = join(dir, 's.jsonl')
  await writeFile(file, '{"type":"session","version":3,"id":"s","timestamp":"t","cwd":"/w"}\n')
  await appendSessionName(file, 'Name', () => events.push('allowed'))
  expect(events.slice(-3)).toEqual(['tail', 'allowed', 'append'])
})
