import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repointSessionCwd } from './session-cwd'
import { parseSessionFile } from './session-scanner'

let temp: string

const OLD_CWD = '/work/sandbox-7'
const NEW_CWD = '/work/knowledge & reporting'

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'session',
    version: 3,
    id: 'sess-uuid-1',
    timestamp: '2026-09-14T14:34:10.810Z',
    cwd: OLD_CWD,
    ...overrides,
  }
}

const BODY =
  line({
    type: 'message',
    id: 'aaaa0001',
    parentId: null,
    timestamp: '2026-09-14T14:34:11.000Z',
    // Mentions the old path in CONTENT: history, not structure, and must not
    // be rewritten — the model really did read that file at that path.
    message: { role: 'user', content: `read ${OLD_CWD}/notes.md`, timestamp: 1 },
  }) +
  line({
    type: 'message',
    id: 'aaaa0002',
    parentId: 'aaaa0001',
    timestamp: '2026-09-14T14:34:12.000Z',
    message: { role: 'assistant', content: 'done', timestamp: 2 },
  })

async function writeSession(name: string, content: string): Promise<string> {
  const path = join(temp, name)
  await writeFile(path, content)
  return path
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'phosphor-session-cwd-'))
})

afterEach(async () => {
  await rm(temp, { recursive: true, force: true })
})

describe('repointSessionCwd', () => {
  it('keeps a repointed transcript readable by the scanner', async () => {
    const path = await writeSession('a.jsonl', line(header()) + BODY)

    expect(await repointSessionCwd(path, OLD_CWD, NEW_CWD)).toBe(true)

    // Still LF-terminated JSONL the real scanner can read back.
    expect(await parseSessionFile(path, 0)).not.toBeNull()
  })
})
