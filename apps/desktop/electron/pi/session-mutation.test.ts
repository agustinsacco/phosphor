import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { appendBranchJump, appendLabel, forkSessionAt } from './session-writer'

/**
 * Offline edits to pi's own transcripts. The first block pins what the writer
 * produces today through its original exports; the lock boundary that wraps
 * it must not change a byte of that output.
 */

const HEADER = {
  type: 'session',
  version: 3,
  id: 'sess-uuid-1',
  timestamp: '2026-08-01T10:00:00.000Z',
  cwd: '/work/proj',
}
const line = (value: unknown): string => JSON.stringify(value) + '\n'
const SOURCE =
  line(HEADER) +
  line({ type: 'message', id: 'aaaa0001', parentId: null, message: { role: 'user' } }) +
  line({ type: 'message', id: 'aaaa0002', parentId: 'aaaa0001', message: { role: 'assistant' } })
const LEAF = 'aaaa0002'
const JUMP_SUMMARY = 'Jumped here from another branch in Phosphor (tree view).'

function entries(raw: string): Record<string, unknown>[] {
  expect(raw.endsWith('\n')).toBe(true)
  return raw
    .slice(0, -1)
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

let dir: string
let source: string

beforeEach(async () => {
  dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'phosphor-mutation-')))
  source = join(dir, '2026-08-01T10-00-00-000Z_sess-uuid-1.jsonl')
  await writeFile(source, SOURCE, 'utf8')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writer output before the lock boundary (characterization)', () => {
  it('appendLabel appends exactly one label line parented on the leaf', async () => {
    await appendLabel(source, 'aaaa0001', 'checkpoint')
    const raw = await readFile(source, 'utf8')
    expect(raw.startsWith(SOURCE)).toBe(true)
    const label = entries(raw.slice(SOURCE.length))
    expect(label).toEqual([
      {
        type: 'label',
        id: expect.stringMatching(/^[0-9a-f]{8}$/),
        parentId: LEAF,
        timestamp: expect.any(String),
        targetId: 'aaaa0001',
        label: 'checkpoint',
      },
    ])
  })

  it('appendBranchJump appends one branch_summary, and nothing at the leaf', async () => {
    await appendBranchJump(source, LEAF)
    expect(await readFile(source, 'utf8')).toBe(SOURCE)

    await appendBranchJump(source, 'aaaa0001')
    const raw = await readFile(source, 'utf8')
    expect(raw.startsWith(SOURCE)).toBe(true)
    expect(entries(raw.slice(SOURCE.length))).toEqual([
      {
        type: 'branch_summary',
        id: expect.stringMatching(/^[0-9a-f]{8}$/),
        parentId: 'aaaa0001',
        timestamp: expect.any(String),
        fromId: LEAF,
        summary: JUMP_SUMMARY,
      },
    ])
  })

  it('forkSessionAt resolves with a sibling that already holds its jump', async () => {
    const fork = await forkSessionAt(source, 'aaaa0001')
    expect(dirname(fork)).toBe(dir)
    expect(basename(fork)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}\.jsonl$/,
    )
    const [header, ...rest] = entries(await readFile(fork, 'utf8'))
    expect(header).toEqual({
      ...HEADER,
      id: basename(fork).slice(25, -6),
      timestamp: expect.any(String),
      parentSession: source,
    })
    expect(rest.slice(0, 2)).toEqual(entries(SOURCE).slice(1))
    expect(rest.slice(2)).toEqual([
      expect.objectContaining({ type: 'branch_summary', parentId: 'aaaa0001', fromId: LEAF }),
    ])
    expect(await readFile(source, 'utf8')).toBe(SOURCE)
  })

  it('keeps the spelling it was given: a symlinked folder stays in parentSession', async () => {
    const real = join(dir, 'real')
    mkdirSync(real)
    const file = join(real, basename(source))
    await writeFile(file, SOURCE, 'utf8')
    const alias = join(dir, 'alias')
    symlinkSync(real, alias)

    await appendLabel(join(alias, basename(source)), 'aaaa0001', 'via alias')
    expect(entries(await readFile(file, 'utf8')).at(-1)).toMatchObject({ label: 'via alias' })

    const fork = await forkSessionAt(join(alias, basename(source)), 'aaaa0001')
    expect(dirname(fork)).toBe(alias)
    expect(entries(await readFile(fork, 'utf8'))[0]).toMatchObject({
      parentSession: join(alias, basename(source)),
    })
  })

  it('rejects a missing transcript with ENOENT and does not create it', async () => {
    const missing = join(dir, 'gone.jsonl')
    await expect(appendLabel(missing, 'aaaa0001', 'x')).rejects.toThrow(/ENOENT/)
    await expect(appendBranchJump(missing, 'aaaa0001')).rejects.toThrow(/ENOENT/)
    await expect(forkSessionAt(missing, 'aaaa0001')).rejects.toThrow(/ENOENT/)
    expect(existsSync(missing)).toBe(false)
  })
})
