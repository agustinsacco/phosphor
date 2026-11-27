import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendSessionName } from './session-writer'

const header = { type: 'session', version: 3, id: 's', timestamp: 't', cwd: '/w' }
const message = {
  type: 'message',
  id: 'm1',
  parentId: null,
  timestamp: 't',
  message: { role: 'user', content: 'hi', timestamp: 1 },
}
let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'writer-tail-'))
  file = join(dir, 's.jsonl')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const records = async () =>
  (await readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .flatMap((text) => {
      try {
        return [JSON.parse(text) as { type: string; id?: string; name?: string }]
      } catch {
        return []
      }
    })

it('keeps an unterminated last message readable and the name its own record', async () => {
  await writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}`)
  await appendSessionName(file, 'Renamed', () => {})
  const read = await records()
  expect(read.map((r) => r.type)).toEqual(['session', 'message', 'session_info'])
  expect(read.at(-1)).toMatchObject({ name: 'Renamed', parentId: 'm1' })
})

it('starts the name on its own line after a torn tail', async () => {
  await writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n{"type":"mess`)
  await appendSessionName(file, 'Renamed', () => {})
  expect((await records()).at(-1)).toMatchObject({ type: 'session_info', name: 'Renamed' })
})
