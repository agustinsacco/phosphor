import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyFold,
  foldFrom,
  metaFromFold,
  readSignature,
  RESUME_SIGNATURE_BYTES,
} from './session-fold'
import { clearSessionCaches, listSessions, parseSessionFile } from './session-scanner'
import { sessionDirNameForCwd } from './pi-paths'

/**
 * The incremental parse exists to stop re-reading a whole session file on
 * every turn (MEASURED: 25 MB on disk cost 815 MB of re-parsing). It is only
 * worth having if it is EXACTLY equal to the full parse — `branchCount`, the
 * token sums and the cost all reach the sidebar and the cost display, so
 * "close enough" is a wrong number shown to the user.
 *
 * These tests therefore compare the two directly, entry by entry, rather than
 * asserting hand-written expectations.
 */

const HEADER = {
  type: 'session',
  version: 3,
  id: 'sess-uuid-1',
  timestamp: '2026-08-01T10:00:00.000Z',
  cwd: '/work/proj',
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

/** One turn's worth of entries: a user message, then an assistant reply. */
function turn(index: number, parent: string | null, text = 'ok'): string {
  const userId = `u${String(index).padStart(4, '0')}`
  const assistantId = `a${String(index).padStart(4, '0')}`
  return (
    line({
      type: 'message',
      id: userId,
      parentId: parent,
      timestamp: `2026-08-01T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
      message: { role: 'user', content: `${text} ${index}`, timestamp: index },
    }) +
    line({
      type: 'message',
      id: assistantId,
      parentId: userId,
      timestamp: `2026-08-01T10:${String(index % 60).padStart(2, '0')}:30.000Z`,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `reply ${index} — “curly” ✅ 日本語` },
          { type: 'toolCall', id: `c${index}`, name: 'bash', arguments: { command: 'make' } },
        ],
        usage: {
          input: 10 + index,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          cost: { total: 0.001 * (index + 1) },
        },
        timestamp: index,
      },
    })
  )
}

describe('foldFrom', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phosphor-fold-'))
    path = join(dir, 'session.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** Fold the file in one pass, then in `steps` resumed passes; compare. */
  async function foldsAgree(content: string, steps: number[]): Promise<void> {
    await writeFile(path, content, 'utf8')
    const whole = emptyFold()
    await foldFrom(path, 0, whole)

    await writeFile(path, '', 'utf8')
    const piecewise = emptyFold()
    let offset = 0
    let written = 0
    for (const step of steps) {
      await appendFile(path, content.slice(written, written + step), 'utf8')
      written += step
      offset = await foldFrom(path, offset, piecewise)
    }
    await appendFile(path, content.slice(written), 'utf8')
    await foldFrom(path, offset, piecewise)

    expect(metaFromFold(piecewise, path, 1)).toEqual(metaFromFold(whole, path, 1))
    expect([...piecewise.seenParents].sort()).toEqual([...whole.seenParents].sort())
  }

  it('matches a whole-file fold when resumed at every turn boundary', async () => {
    let content = line(HEADER)
    let parent: string | null = null
    const steps: number[] = []
    for (let i = 0; i < 40; i++) {
      const before = content.length
      content += turn(i, parent)
      parent = `a${String(i).padStart(4, '0')}`
      steps.push(content.length - before)
    }
    // The first step must also carry the header.
    steps[0] = (steps[0] ?? 0) + line(HEADER).length
    await foldsAgree(content, steps.slice(0, -1))
  })

  it('matches when resumed at byte offsets that split lines and multi-byte characters', async () => {
    // The nasty case: a resume boundary landing inside a UTF-8 sequence. Byte
    // framing is what makes this safe; a string-level split could not report
    // an exact offset to resume from.
    let content = line(HEADER)
    let parent: string | null = null
    for (let i = 0; i < 12; i++) {
      content += turn(i, parent)
      parent = `a${String(i).padStart(4, '0')}`
    }
    await foldsAgree(content, [7, 1, 233, 1, 64, 1024, 3, 511])
  })

  it('counts branches identically when resumed', async () => {
    // Two entries naming the same parent IS a branch; the parent may have
    // been seen in an earlier pass, which is what `seenParents` has to carry.
    const content =
      line(HEADER) +
      turn(0, null) +
      line({
        type: 'message',
        id: 'b0001',
        parentId: 'u0000',
        timestamp: '2026-08-01T10:05:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'other branch' }] },
      }) +
      turn(1, 'a0000')
    // Split so the branching entry lands in a later pass than its parent.
    await foldsAgree(content, [line(HEADER).length + turn(0, null).length])
  })

  it('does not consume a half-written trailing record', async () => {
    const complete = line(HEADER) + turn(0, null)
    const partial = '{"type":"message","id":"u0001"'
    await writeFile(path, complete + partial, 'utf8')

    const state = emptyFold()
    const consumed = await foldFrom(path, 0, state)
    expect(consumed).toBe(Buffer.byteLength(complete))
    expect(state.entryCount).toBe(2)

    // Finishing the record makes it count, exactly once.
    await appendFile(path, '}\n', 'utf8')
    await foldFrom(path, consumed, state)
    expect(state.entryCount).toBe(3)
  })

  it('accepts CRLF without miscounting the offset', async () => {
    const content = (line(HEADER) + turn(0, null)).replace(/\n/g, '\r\n')
    await writeFile(path, content, 'utf8')
    const state = emptyFold()
    const consumed = await foldFrom(path, 0, state)
    expect(consumed).toBe(Buffer.byteLength(content))
    expect(state.userMessages).toBe(1)
    expect(state.assistantMessages).toBe(1)
  })
})

/**
 * `firstEntryId` is what tells a rewind's branch apart from a plain successor
 * session: only a branch copies its parent's entries, so only a branch repeats
 * that id. It must survive the incremental path, which never sees line 1 again.
 */
describe('firstEntryId', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phosphor-first-entry-'))
    path = join(dir, 'session.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is the first entry after the header, and is not overwritten by a resumed fold', async () => {
    await writeFile(path, line(HEADER) + turn(0, null), 'utf8')
    const state = emptyFold()
    const offset = await foldFrom(path, 0, state)
    expect(metaFromFold(state, path, 0)?.firstEntryId).toBe('u0000')

    await appendFile(path, turn(1, 'a0000'), 'utf8')
    await foldFrom(path, offset, state)
    expect(metaFromFold(state, path, 0)?.firstEntryId).toBe('u0000')
  })

  it('stays undefined for a header-only file', async () => {
    await writeFile(path, line(HEADER), 'utf8')
    const state = emptyFold()
    await foldFrom(path, 0, state)
    expect(metaFromFold(state, path, 0)?.firstEntryId).toBeUndefined()
  })
})

describe('readSignature', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phosphor-sig-'))
    path = join(dir, 'session.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is stable across an append and changes on a rewrite', async () => {
    await writeFile(path, 'x'.repeat(500), 'utf8')
    const before = await readSignature(path, 500)

    await appendFile(path, 'more', 'utf8')
    expect(await readSignature(path, 500)).toBe(before)

    // Rewriting the bytes at the boundary must be detectable.
    await writeFile(path, 'y'.repeat(500) + 'more', 'utf8')
    expect(await readSignature(path, 500)).not.toBe(before)
  })

  it('reports null when the file is shorter than the offset', async () => {
    await writeFile(path, 'x'.repeat(10), 'utf8')
    expect(await readSignature(path, 500)).toBeNull()
  })

  it('handles an offset inside the signature window', async () => {
    await writeFile(path, 'x'.repeat(RESUME_SIGNATURE_BYTES - 10), 'utf8')
    expect(await readSignature(path, RESUME_SIGNATURE_BYTES - 10)).not.toBeNull()
  })
})

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

describe('headroom receipts', () => {
  function toolResult(id: string, parent: string, details: unknown): string {
    return line({
      type: 'message',
      id,
      parentId: parent,
      timestamp: '2026-08-01T11:00:00.000Z',
      message: {
        role: 'toolResult',
        toolCallId: `call-${id}`,
        toolName: 'mcpScript',
        content: [{ type: 'text', text: '[3]{id:string}\n1\n2\n3' }],
        details,
        isError: false,
        timestamp: 1,
      },
    })
  }

  it('sums details.headroom.savedTokens from toolResult messages into the meta', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-hr-'))
    const path = join(dir, 's.jsonl')
    const content =
      line(HEADER) +
      turn(0, null) +
      toolResult('t1', 'a0000', {
        headroom: { savedTokens: 1257, beforeTokens: 2875, afterTokens: 1618, ms: 18 },
      }) +
      toolResult('t2', 't1', {
        mode: 'script',
        headroom: { savedTokens: 500, beforeTokens: 900, afterTokens: 400, ms: 9 },
      })
    await writeFile(path, content, 'utf8')

    const meta = await parseSessionFile(path, (await stat(path)).mtimeMs)
    expect(meta?.headroomSavedTokens).toBe(1757)
    await rm(dir, { recursive: true, force: true })
  })

  it('ignores tool results without a receipt, and malformed receipts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-hr-'))
    const path = join(dir, 's.jsonl')
    const content =
      line(HEADER) +
      turn(0, null) +
      toolResult('t1', 'a0000', { mode: 'script' }) +
      toolResult('t2', 't1', { headroom: { savedTokens: 'lots' } }) +
      toolResult('t3', 't2', { headroom: { savedTokens: -50 } }) +
      toolResult('t4', 't3', null)
    await writeFile(path, content, 'utf8')

    const meta = await parseSessionFile(path, (await stat(path)).mtimeMs)
    expect(meta?.headroomSavedTokens).toBe(0)
    await rm(dir, { recursive: true, force: true })
  })

  it('matches the whole-file fold when resumed across a receipt boundary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-hr-'))
    const path = join(dir, 's.jsonl')
    const first = line(HEADER) + turn(0, null)
    const second = toolResult('t1', 'a0000', {
      headroom: { savedTokens: 42, beforeTokens: 100, afterTokens: 58, ms: 5 },
    })
    await writeFile(path, first, 'utf8')

    const resumed = emptyFold()
    const offset = await foldFrom(path, 0, resumed)
    await appendFile(path, second, 'utf8')
    await foldFrom(path, offset, resumed)

    const whole = emptyFold()
    await foldFrom(path, 0, whole)
    expect(resumed.headroomSavedTokens).toBe(42)
    expect(resumed.headroomSavedTokens).toBe(whole.headroomSavedTokens)
    await rm(dir, { recursive: true, force: true })
  })
})
