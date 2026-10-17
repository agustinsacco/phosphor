import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionTree } from './session-tree'

/**
 * A session file is pi's, and anything can land in it: a hand edit, a torn
 * write, a provider that put an object where pi puts a string. One such row
 * used to throw out of `readSessionTree` and blank the whole tree view. These
 * pin that a malformed row costs only itself — or only its malformed fields —
 * and every valid row around it, and the leaf, survive.
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

function message(id: string, parentId: string | null, body: unknown): Record<string, unknown> {
  return { type: 'message', id, parentId, timestamp: '2026-08-01T10:00:01.000Z', message: body }
}

describe('readSessionTree', () => {
  let dir: string
  let sessionPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phosphor-tree-'))
    sessionPath = join(dir, '2026-08-01T10-00-00-000Z_sess-uuid-1.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function treeOf(...rows: string[]) {
    await writeFile(sessionPath, rows.join(''), 'utf8')
    const read = readSessionTree(sessionPath)
    // A malformed row must never reject the whole read.
    await expect(read).resolves.toBeDefined()
    return read
  }

  it('skips a null or non-record line and keeps every valid row around it', async () => {
    const tree = await treeOf(
      line(HEADER),
      line(message('aaaa0001', null, { role: 'user', content: 'first' })),
      'null\n',
      '42\n',
      '"a string"\n',
      '[1, 2]\n',
      line(message('aaaa0002', 'aaaa0001', { role: 'user', content: 'second' })),
    )

    expect(tree.sessionId).toBe('sess-uuid-1')
    expect(tree.entries.map((e) => e.id)).toEqual(['aaaa0001', 'aaaa0002'])
    expect(tree.leafId).toBe('aaaa0002')
  })

  it('drops a numeric or object summary but keeps the row and every later one', async () => {
    const tree = await treeOf(
      line(HEADER),
      line(message('aaaa0001', null, { role: 'user', content: 'first' })),
      line({ type: 'compaction', id: 'aaaa0002', parentId: 'aaaa0001', summary: 42 }),
      line({ type: 'branch_summary', id: 'aaaa0003', parentId: 'aaaa0002', summary: { t: 1 } }),
      line({ type: 'compaction', id: 'aaaa0004', parentId: 'aaaa0003', summary: 'kept' }),
      line(message('aaaa0005', 'aaaa0004', { role: 'user', content: 'after' })),
    )

    expect(tree.entries.map((e) => e.id)).toEqual([
      'aaaa0001',
      'aaaa0002',
      'aaaa0003',
      'aaaa0004',
      'aaaa0005',
    ])
    const byId = new Map(tree.entries.map((e) => [e.id, e]))
    expect(byId.get('aaaa0002')).not.toHaveProperty('summary')
    expect(byId.get('aaaa0003')).not.toHaveProperty('summary')
    expect(byId.get('aaaa0004')?.summary).toBe('kept')
    expect(tree.leafId).toBe('aaaa0005')
  })

  it('reads previews and tool names past invalid content blocks', async () => {
    const tree = await treeOf(
      line(HEADER),
      line(
        message('aaaa0001', null, {
          role: 'user',
          content: [
            null,
            7,
            'stray',
            { type: 'text', text: { nested: true } },
            { type: 'text', text: 'hello' },
          ],
        }),
      ),
      line(
        message('aaaa0002', 'aaaa0001', {
          role: 'assistant',
          content: [
            null,
            { type: 'text', text: 'Building.' },
            { type: 'toolCall', id: 'c0', name: 5 },
            { type: 'toolCall', id: 'c1', name: { n: 'bash' } },
            { type: 'toolCall', id: 'c2', name: 'bash' },
            ['nested'],
          ],
        }),
      ),
      line(message('aaaa0003', 'aaaa0002', { role: 'user', content: 'after' })),
    )

    const [user, assistant] = tree.entries
    expect(user?.preview).toBe('hello')
    expect(assistant?.preview).toBe('Building.')
    expect(assistant?.toolName).toBe('bash')
    expect(tree.leafId).toBe('aaaa0003')
  })

  it('skips rows whose id or type is not a string, leaving the leaf on the last valid row', async () => {
    const tree = await treeOf(
      line(HEADER),
      line(message('aaaa0001', null, { role: 'user', content: 'first' })),
      line(message('aaaa0002', 'aaaa0001', { role: 'user', content: 'valid' })),
      line({ ...message('x', 'aaaa0002', { role: 'user', content: 'n' }), id: 42 }),
      line({ ...message('bbbb0001', 'aaaa0002', { role: 'user', content: 't' }), type: 7 }),
      line({ type: 'label', id: { nested: 'aaaa0009' }, parentId: 'aaaa0002', targetId: 'x' }),
    )

    expect(tree.entries.map((e) => e.id)).toEqual(['aaaa0001', 'aaaa0002'])
    expect(tree.leafId).toBe('aaaa0002')
  })

  it('reads a malformed header as empty and omits every invalid optional field', async () => {
    const at = '2026-08-01T10:00:01.000Z'
    const tree = await treeOf(
      line({ type: 'session', id: 99, cwd: ['/work/proj'] }),
      line({ type: 'message', id: 'aaaa0001', parentId: 5, timestamp: 123, message: { role: 9 } }),
      line({ type: 'message', id: 'aaaa0002', parentId: 'aaaa0001', timestamp: at, message: 'x' }),
      line(message('aaaa0003', 'aaaa0002', { role: 'toolResult', toolName: 4 })),
      line({
        type: 'label',
        id: 'aaaa0004',
        parentId: 'aaaa0003',
        timestamp: at,
        targetId: 3,
        label: {},
      }),
      line({ type: 'session_info', id: 'aaaa0005', parentId: 'aaaa0004', timestamp: at, name: 5 }),
      line({
        type: 'model_change',
        id: 'aaaa0006',
        parentId: 'aaaa0005',
        timestamp: at,
        provider: 1,
        modelId: null,
      }),
      line({
        type: 'thinking_level_change',
        id: 'aaaa0007',
        parentId: 'aaaa0006',
        timestamp: at,
        thinkingLevel: true,
      }),
    )

    expect(tree.sessionId).toBe('')
    expect(tree.cwd).toBe('')
    expect(tree.entries).toStrictEqual([
      { id: 'aaaa0001', parentId: null, type: 'message', timestamp: '' },
      { id: 'aaaa0002', parentId: 'aaaa0001', type: 'message', timestamp: at },
      { id: 'aaaa0003', parentId: 'aaaa0002', type: 'message', timestamp: at, role: 'toolResult' },
      { id: 'aaaa0004', parentId: 'aaaa0003', type: 'label', timestamp: at },
      { id: 'aaaa0005', parentId: 'aaaa0004', type: 'session_info', timestamp: at },
      { id: 'aaaa0006', parentId: 'aaaa0005', type: 'model_change', timestamp: at },
      { id: 'aaaa0007', parentId: 'aaaa0006', type: 'thinking_level_change', timestamp: at },
    ])
    expect(tree.leafId).toBe('aaaa0007')
  })

  it('reads every field of a well-formed transcript', async () => {
    const at = '2026-08-01T10:00:01.000Z'
    const long = 'x'.repeat(500)
    const tree = await treeOf(
      line(HEADER),
      line({
        type: 'model_change',
        id: 'm1',
        parentId: null,
        timestamp: at,
        provider: 'p',
        modelId: 'm',
      }),
      line({
        type: 'thinking_level_change',
        id: 't1',
        parentId: 'm1',
        timestamp: at,
        thinkingLevel: 'high',
      }),
      line(message('u1', 't1', { role: 'user', content: [{ type: 'text', text: 'hi' }] })),
      line(
        message('a1', 'u1', {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Reading.' },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: {} },
            { type: 'toolCall', id: 'c2', name: 'grep', arguments: {} },
          ],
        }),
      ),
      line(message('r1', 'a1', { role: 'toolResult', toolName: 'read', content: [] })),
      line({ type: 'label', id: 'l1', parentId: 'r1', timestamp: at, targetId: 'u1', label: 'cp' }),
      line({ type: 'compaction', id: 'c1', parentId: 'l1', timestamp: at, summary: long }),
      line({ type: 'session_info', id: 's1', parentId: 'c1', timestamp: at, name: 'Named' }),
    )

    expect(tree).toEqual({
      sessionId: 'sess-uuid-1',
      cwd: '/work/proj',
      leafId: 's1',
      entries: [
        {
          id: 'm1',
          parentId: null,
          type: 'model_change',
          timestamp: at,
          provider: 'p',
          modelId: 'm',
        },
        {
          id: 't1',
          parentId: 'm1',
          type: 'thinking_level_change',
          timestamp: at,
          thinkingLevel: 'high',
        },
        { id: 'u1', parentId: 't1', type: 'message', timestamp: at, role: 'user', preview: 'hi' },
        {
          id: 'a1',
          parentId: 'u1',
          type: 'message',
          timestamp: at,
          role: 'assistant',
          preview: 'Reading.',
          toolName: 'read, grep',
        },
        {
          id: 'r1',
          parentId: 'a1',
          type: 'message',
          timestamp: at,
          role: 'toolResult',
          toolName: 'read',
        },
        { id: 'l1', parentId: 'r1', type: 'label', timestamp: at, targetId: 'u1', label: 'cp' },
        { id: 'c1', parentId: 'l1', type: 'compaction', timestamp: at, summary: 'x'.repeat(400) },
        { id: 's1', parentId: 'c1', type: 'session_info', timestamp: at, name: 'Named' },
      ],
    })
  })
})
