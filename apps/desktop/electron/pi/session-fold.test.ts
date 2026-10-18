import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HEADER, line, turn } from '@phosphor/session-runtime/pi/__fixtures__/session-fold-input'
import { clearSessionCaches, listSessions, parseSessionFile } from './session-scanner'
import { sessionDirNameForCwd } from './pi-paths'

/**
 * End to end through the scanner: the sidebar must see the same numbers
 * whether a session was scanned once at the end or re-scanned every turn as
 * it grew. This is the test that would fail if the resume cache ever
 * double-counted.
 */
describe('listSessions with a growing session', () => {
  let root: string
  let sessionDir: string
  let path: string
  const cwd = '/work/growing'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'phosphor-scan-'))
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    sessionDir = join(root, sessionDirNameForCwd(cwd))
    await rm(sessionDir, { recursive: true, force: true })
    path = join(sessionDir, '2026-08-01T10-00-00-000Z_sess-uuid-1.jsonl')
    clearSessionCaches()
  })

  afterEach(async () => {
    delete process.env.PI_CODING_AGENT_SESSION_DIR
    await rm(root, { recursive: true, force: true })
    clearSessionCaches()
  })

  async function write(content: string): Promise<void> {
    await mkdir(sessionDir, { recursive: true })
    await writeFile(path, content, 'utf8')
  }

  it('reports the same meta as a cold scan of the finished file', async () => {
    let content = line({ ...HEADER, cwd })
    await write(content)

    let parent: string | null = null
    for (let i = 0; i < 25; i++) {
      content += turn(i, parent)
      parent = `a${String(i).padStart(4, '0')}`
      await writeFile(path, content, 'utf8')
      // Each pass resumes from the last, exactly as a `sessions:changed` push
      // would drive it.
      const [meta] = await listSessions(cwd)
      expect(meta).toBeTruthy()
    }
    const [incremental] = await listSessions(cwd)

    clearSessionCaches()
    const [cold] = await listSessions(cwd)

    expect(incremental).toEqual(cold)
    expect(incremental).toEqual(await parseSessionFile(path, (await stat(path)).mtimeMs))
  })

  it('recovers when the file is truncated instead of appended to', async () => {
    let content = line({ ...HEADER, cwd })
    let parent: string | null = null
    for (let i = 0; i < 10; i++) {
      content += turn(i, parent)
      parent = `a${String(i).padStart(4, '0')}`
    }
    await write(content)
    await listSessions(cwd)

    const keep = line({ ...HEADER, cwd }) + turn(0, null)
    await truncate(path, Buffer.byteLength(keep))
    const [afterTruncate] = await listSessions(cwd)

    clearSessionCaches()
    const [cold] = await listSessions(cwd)
    expect(afterTruncate).toEqual(cold)
  })

  it('recovers when the file is rewritten at the same length', async () => {
    // Not something pi does today, but the resume path must never trust a
    // boundary it has not re-checked.
    const first = line({ ...HEADER, cwd }) + turn(0, null, 'alpha')
    await write(first)
    await listSessions(cwd)

    const second = line({ ...HEADER, cwd }) + turn(0, null, 'bravo')
    expect(Buffer.byteLength(second)).toBe(Buffer.byteLength(first))
    await writeFile(path, second, 'utf8')
    // Bump mtime explicitly. Same size and (often) the same millisecond means
    // the outer (mtime,size) cache would otherwise answer before the resume
    // path is reached, and this test is about the resume path.
    const future = new Date(Date.now() + 5_000)
    await utimes(path, future, future)
    const [rewritten] = await listSessions(cwd)

    clearSessionCaches()
    const [cold] = await listSessions(cwd)
    expect(rewritten?.firstUserText).toBe(cold?.firstUserText)
  })

  it('forgets a session that has been deleted from the directory', async () => {
    await write(line({ ...HEADER, cwd }) + turn(0, null))
    expect(await listSessions(cwd)).toHaveLength(1)

    await rm(path)
    expect(await listSessions(cwd)).toHaveLength(0)
  })
})

/**
 * A file with no `type: "session"` header has no meta to show, and that
 * answer has to be cached like any other. MEASURED before this: one 3.2 MB
 * headerless file in a real workspace was fully re-parsed on every single
 * sidebar refresh, because only a non-null meta was ever stored.
 */
describe('headerless session files', () => {
  let root: string
  let sessionDir: string
  let path: string
  const cwd = '/work/headerless'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'phosphor-headerless-'))
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    sessionDir = join(root, sessionDirNameForCwd(cwd))
    await mkdir(sessionDir, { recursive: true })
    path = join(sessionDir, '2026-08-01T10-00-00-000Z_no-header.jsonl')
    clearSessionCaches()
  })

  afterEach(async () => {
    delete process.env.PI_CODING_AGENT_SESSION_DIR
    await rm(root, { recursive: true, force: true })
    clearSessionCaches()
  })

  it('is left out of the listing but is not re-read on an unchanged scan', async () => {
    const body = line({
      type: 'message',
      id: 'u0000',
      parentId: null,
      timestamp: '2026-08-01T10:00:00.000Z',
      message: { role: 'user', content: 'hello', timestamp: 0 },
    })
    const valid = line({ ...HEADER, cwd }) + body
    // Same BYTE length, so (mtime, size) cannot tell the two apart. Blank
    // lines are skipped by the fold, which makes them free padding.
    let headerless = body
    while (Buffer.byteLength(headerless) < Buffer.byteLength(valid)) headerless += '\n'
    expect(Buffer.byteLength(headerless)).toBe(Buffer.byteLength(valid))

    // Pinned on both sides: APFS records mtime below millisecond resolution,
    // and `utimes` truncates, so re-stamping from a read-back Date would
    // change mtimeMs and defeat the very cache under test.
    const stamp = new Date(1_800_000_000_000)
    await writeFile(path, headerless, 'utf8')
    await utimes(path, stamp, stamp)
    expect(await listSessions(cwd)).toHaveLength(0)

    // Swap in a VALID session of identical size and mtime. Anything that
    // re-read the file would now report one session; the cached "nothing
    // here" must win instead.
    await writeFile(path, valid, 'utf8')
    await utimes(path, stamp, stamp)
    expect(await listSessions(cwd)).toHaveLength(0)

    // A genuine change is still picked up.
    const later = new Date(Number(stamp) + 5_000)
    await utimes(path, later, later)
    expect(await listSessions(cwd)).toHaveLength(1)
  })
})

/**
 * The receipt is a WIRE CONTRACT with pi: the extension returns a `details`
 * patch from its `tool_result` hook and pi persists it verbatim into the
 * session file. Nothing in this repo compiles against that, so the guard is
 * a session file captured from a real run — pi 0.85.1, Headroom 0.37.0,
 * 2026-09-08 — replayed through the real fold.
 *
 * It also pins what "lossless" meant on that run: 120 JSON records came back
 * as a typed header plus 120 CSV rows, and the model answered the count and
 * the last id exactly from the compressed text.
 */
describe('a real captured session', () => {
  const fixture = join(__dirname, '__fixtures__', 'headroom-live-session.jsonl')

  it('folds the receipt pi actually persisted', async () => {
    const meta = await parseSessionFile(fixture, (await stat(fixture)).mtimeMs)
    expect(meta?.headroomSavedTokens).toBe(1931)
  })

  it('kept every record the uncompressed result had', async () => {
    const entries = (await readFile(fixture, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { message?: { role?: string; content?: unknown } })

    const result = entries.find((e) => e.message?.role === 'toolResult')
    const blocks = result?.message?.content as Array<{ text: string }> | undefined
    const text = blocks?.[0]?.text ?? ''
    const [header, ...rows] = text.trim().split('\n')
    // SmartCrusher's lossless restructure: "[count]{field:type,…}" then rows.
    expect(header).toMatch(/^\[120\]\{.*id:string.*\}$/)
    expect(rows).toHaveLength(120)
    expect(rows[119]).toContain('ISS-0119')

    // And the model read it correctly — the fidelity claim, end to end.
    const answer = entries
      .flatMap((e) =>
        e.message?.role === 'assistant'
          ? ((e.message.content ?? []) as Array<{ text?: string }>)
          : [],
      )
      .map((b) => b.text ?? '')
      .join('\n')
    expect(answer).toContain('120')
    expect(answer).toContain('ISS-0119')
  })
})
