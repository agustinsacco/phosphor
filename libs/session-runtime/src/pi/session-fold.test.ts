import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyFold,
  foldFrom,
  metaFromFold,
  readSignature,
  RESUME_SIGNATURE_BYTES,
} from './session-fold'
import { HEADER, line, turn } from './__fixtures__/session-fold-input'

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

  it('resumes after writes ending inside a UTF-8 sequence without consuming the partial line', async () => {
    const content = Buffer.from(line(HEADER) + turn(0, null))
    const unicodeStart = content.indexOf(Buffer.from('日'))
    const lineStart = content.lastIndexOf(0x0a, unicodeStart) + 1
    const whole = emptyFold()
    await writeFile(path, content)
    await foldFrom(path, 0, whole)

    await writeFile(path, content.subarray(0, unicodeStart + 1))
    const resumed = emptyFold()
    const offset = await foldFrom(path, 0, resumed)
    expect(offset).toBe(lineStart)
    expect(resumed.assistantMessages).toBe(0)

    await appendFile(path, content.subarray(unicodeStart + 1, unicodeStart + 2))
    expect(await foldFrom(path, offset, resumed)).toBe(offset)
    await appendFile(path, content.subarray(unicodeStart + 2))
    expect(await foldFrom(path, offset, resumed)).toBe(content.length)
    expect(metaFromFold(resumed, path, 1)).toEqual(metaFromFold(whole, path, 1))
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

    const state = emptyFold()
    await foldFrom(path, 0, state)
    const meta = metaFromFold(state, path, 0)
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

    const state = emptyFold()
    await foldFrom(path, 0, state)
    const meta = metaFromFold(state, path, 0)
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
