import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { healMissingSessionCwd, repointSessionCwd } from './session-cwd'
import { sessionDirNameForCwd } from './pi-paths'
import { parseSessionFile } from './session-scanner'

/**
 * This module rewrites a line of the user's real transcript in place, so every
 * test re-reads the whole file: the header must be the only thing that changed
 * and the result must still parse as the JSONL pi wrote.
 */

let temp: string
let sessionsRoot: string

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
  sessionsRoot = join(temp, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot
})

afterEach(async () => {
  delete process.env.PI_CODING_AGENT_SESSION_DIR
  await rm(temp, { recursive: true, force: true })
})

describe('repointSessionCwd', () => {
  it('rewrites the header cwd and leaves the transcript untouched', async () => {
    const path = await writeSession('a.jsonl', line(header()) + BODY)

    expect(await repointSessionCwd(path, OLD_CWD, NEW_CWD)).toBe(true)

    const text = await readFile(path, 'utf8')
    const [first, ...rest] = text.split('\n')
    expect(JSON.parse(first!)).toEqual(header({ cwd: NEW_CWD }))
    expect(rest.join('\n')).toBe(BODY)
    // Still LF-terminated JSONL the real scanner can read back.
    expect(await parseSessionFile(path, 0)).not.toBeNull()
  })

  it('moves parentSession into the transcript directory the parent moved to', async () => {
    const parent = join(sessionsRoot, sessionDirNameForCwd(OLD_CWD), 'parent.jsonl')
    const path = await writeSession('a.jsonl', line(header({ parentSession: parent })) + BODY)

    expect(await repointSessionCwd(path, OLD_CWD, NEW_CWD)).toBe(true)

    const first = JSON.parse((await readFile(path, 'utf8')).split('\n')[0]!)
    expect(first.parentSession).toBe(
      join(sessionsRoot, sessionDirNameForCwd(NEW_CWD), 'parent.jsonl'),
    )
  })

  it('leaves a parentSession in an unrelated transcript directory alone', async () => {
    // `--work-sandbox-7--` is a prefix of `--work-sandbox-70--`; the separator
    // guard is what stops a rename of the first from claiming the second.
    const other = join(sessionsRoot, sessionDirNameForCwd('/work/sandbox-70'), 'parent.jsonl')
    const path = await writeSession('a.jsonl', line(header({ parentSession: other })) + BODY)

    await repointSessionCwd(path, OLD_CWD, NEW_CWD)

    const first = JSON.parse((await readFile(path, 'utf8')).split('\n')[0]!)
    expect(first.parentSession).toBe(other)
  })

  it('ignores a session whose stored cwd is something else', async () => {
    const content = line(header({ cwd: '/work/elsewhere' })) + BODY
    const path = await writeSession('a.jsonl', content)

    expect(await repointSessionCwd(path, OLD_CWD, NEW_CWD)).toBe(false)
    expect(await readFile(path, 'utf8')).toBe(content)
  })

  it('ignores a file whose first line is not a session header', async () => {
    const content = line({ type: 'message', id: 'x' }) + BODY
    const path = await writeSession('a.jsonl', content)

    expect(await repointSessionCwd(path, OLD_CWD, NEW_CWD)).toBe(false)
    expect(await readFile(path, 'utf8')).toBe(content)
  })

  it('ignores an unparseable first line rather than truncating the file', async () => {
    const content = 'not json\n' + BODY
    const path = await writeSession('a.jsonl', content)

    expect(await repointSessionCwd(path, OLD_CWD, NEW_CWD)).toBe(false)
    expect(await readFile(path, 'utf8')).toBe(content)
  })

  it('handles a header-only session with no trailing newline', async () => {
    const path = await writeSession('a.jsonl', JSON.stringify(header()))

    expect(await repointSessionCwd(path, OLD_CWD, NEW_CWD)).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(header({ cwd: NEW_CWD }))
  })

  it('leaves no temp file behind', async () => {
    const path = await writeSession('a.jsonl', line(header()) + BODY)
    await repointSessionCwd(path, OLD_CWD, NEW_CWD)
    expect((await readdir(temp)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('is a no-op when the two cwds are the same', async () => {
    const path = await writeSession('a.jsonl', line(header()) + BODY)
    expect(await repointSessionCwd(path, OLD_CWD, OLD_CWD)).toBe(false)
  })
})

describe('healMissingSessionCwd', () => {
  it('repoints a session whose stored cwd has gone', async () => {
    const gone = join(temp, 'gone')
    const live = join(temp, 'live')
    await mkdir(live)
    const path = await writeSession('a.jsonl', line(header({ cwd: gone })) + BODY)

    expect(await healMissingSessionCwd(path, live)).toBe(true)
    expect(JSON.parse((await readFile(path, 'utf8')).split('\n')[0]!).cwd).toBe(live)
  })

  it('leaves a session whose stored cwd still exists alone', async () => {
    const stored = join(temp, 'stored')
    const live = join(temp, 'live')
    await mkdir(stored)
    await mkdir(live)
    const content = line(header({ cwd: stored })) + BODY
    const path = await writeSession('a.jsonl', content)

    expect(await healMissingSessionCwd(path, live)).toBe(false)
    expect(await readFile(path, 'utf8')).toBe(content)
  })

  it('refuses to repoint at a cwd that does not exist either', async () => {
    const content = line(header({ cwd: join(temp, 'gone') })) + BODY
    const path = await writeSession('a.jsonl', content)

    expect(await healMissingSessionCwd(path, join(temp, 'also-gone'))).toBe(false)
    expect(await readFile(path, 'utf8')).toBe(content)
  })

  it('returns false for a missing session file', async () => {
    expect(await healMissingSessionCwd(join(temp, 'nope.jsonl'), temp)).toBe(false)
  })
})
