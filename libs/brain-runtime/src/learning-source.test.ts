import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { freezeLearningSource, writeLearningSnapshot } from './learning-source'

const header = {
  type: 'session',
  version: 3,
  id: 'original',
  cwd: '/synthetic',
  timestamp: '2026-01-01',
}
const entry = (id: string, parentId: string | null, text: string, role = 'user') => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-01-01',
  message: { role, content: text, timestamp: 1 },
})
const entries = [
  entry('u', null, 'question'),
  entry('a', 'u', 'final assistant', 'assistant'),
  entry('other', 'u', 'abandoned'),
]
const text = (body: unknown[] = entries, session = header) =>
  [session, ...body].map((x) => JSON.stringify(x)).join('\n') + '\n'
const selection = { sessionId: 'original', selectedLeafId: 'a' }
const directories: string[] = []
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('learning-source immutable selected leaf', () => {
  it('retains the final assistant and exact ancestry, not an abandoned branch or synthetic summary', () => {
    const raw = text()
    const frozen = freezeLearningSource(raw, selection)
    expect(frozen.lines).toEqual(entries.slice(0, 2).map((x) => JSON.stringify(x)))
    expect(frozen.source.entries.map((x) => x.entryId)).toEqual(['u', 'a'])
    expect(raw).toBe(text())
    expect(frozen.lines.join('\n')).not.toContain('branch_summary')
  })
  it('deduplicates copied roots and does not create eligibility from metadata-only appends', () => {
    const original = freezeLearningSource(text(), selection)
    const metadata = {
      type: 'session_info',
      id: 'meta',
      parentId: 'a',
      timestamp: '2026-01-02',
      name: 'renamed',
    }
    const renamed = freezeLearningSource(text([...entries, metadata]), {
      ...selection,
      selectedLeafId: 'meta',
    })
    expect(renamed.source.entries.slice(0, 2)).toEqual(original.source.entries)
    const copy = freezeLearningSource(text(entries, { ...header, id: 'copy' }), {
      ...selection,
      sessionId: 'copy',
    })
    expect(copy.source.contentDigest).toBe(original.source.contentDigest)
  })
  it('deduplicates native fork roots even when a removed label re-chains parents', () => {
    const label = { type: 'label', id: 'label', parentId: 'u', targetId: 'u', label: 'checkpoint' }
    const withLabel = freezeLearningSource(
      text([entries[0], label, { ...entries[1], parentId: 'label' }]),
      selection,
    )
    const withoutLabel = freezeLearningSource(text(), selection)
    expect(withLabel.source.entries.at(-1)?.rootId).toBe(withoutLabel.source.entries.at(-1)?.rootId)
    expect(withLabel.source.entries.at(-1)?.entryHash).not.toBe(
      withoutLabel.source.entries.at(-1)?.entryHash,
    )
  })
  it.each([
    ['torn tail', text() + '{'],
    ['unknown context role', text([entry('a', null, 'unsupported', 'unknown')])],
    ['unknown entry type', text([{ type: 'future', id: 'a', parentId: null }])],
    ['missing leaf', text(entries.slice(0, 1))],
    ['duplicate ID', text([...entries, entries[0]])],
    ['missing parent', text([entry('a', 'absent', 'bad')])],
    ['cycle', text([entry('a', 'a', 'bad')])],
    ['legacy format', text(entries, { ...header, version: 2 })],
  ])('rejects %s', (_name, raw) => expect(() => freezeLearningSource(raw, selection)).toThrow())
  it('writes a private exclusive snapshot and leaves original bytes frozen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'learning-source-'))
    directories.push(dir)
    const sourcePath = join(dir, 'original.jsonl'),
      snapshotPath = join(dir, 'snapshot.jsonl')
    await writeFile(sourcePath, text())
    const inspect = async () => ({ ...selection, settled: true, fence: 'fence-1' })
    const result = await writeLearningSnapshot({ sourcePath, snapshotPath, selection, inspect })
    expect(await readFile(sourcePath, 'utf8')).toBe(text())
    expect(
      createHash('sha256')
        .update(await readFile(sourcePath))
        .digest('hex'),
    ).toBe(result.source.sourceDigest)
    expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600)
    expect((await readFile(snapshotPath, 'utf8')).split('\n').slice(1, -1)).toEqual(result.lines)
    await expect(
      writeLearningSnapshot({ sourcePath, snapshotPath, selection, inspect }),
    ).rejects.toThrow()
  })
  it('rejects busy, changing and missing sources without writing a snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'learning-source-'))
    directories.push(dir)
    const sourcePath = join(dir, 'original.jsonl'),
      snapshotPath = join(dir, 'snapshot.jsonl')
    const inspect = async () => ({ ...selection, settled: false, fence: 'fence-1' })
    await expect(
      writeLearningSnapshot({
        sourcePath,
        snapshotPath,
        selection,
        inspect: async () => ({ ...selection, settled: true, fence: 'missing' }),
      }),
    ).rejects.toThrow(/ENOENT/)
    await writeFile(sourcePath, text())
    await expect(
      writeLearningSnapshot({ sourcePath, snapshotPath, selection, inspect }),
    ).rejects.toThrow(/settled/)
    let calls = 0
    await expect(
      writeLearningSnapshot({
        sourcePath,
        snapshotPath,
        selection,
        inspect: async () => ({ ...selection, settled: true, fence: String(++calls) }),
      }),
    ).rejects.toThrow(/changed/)
    await expect(readFile(snapshotPath)).rejects.toThrow()
  })
})
