import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_TEXT_FILE_BYTES } from '@shared/file-kinds'
import { DEFAULT_SEARCH_OPTIONS, type SearchQuery } from '@shared/text-search'
import { MAX_SEARCH_RESULTS, type FileSearchResult } from '@shared/workspace-search'
import { searchFiles, type SearchBatch, type SearchJob } from './workspace-search'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

async function workspace(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'phosphor-workspace-search-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

const query = (text: string, options: Partial<SearchQuery> = {}): SearchQuery => ({
  ...DEFAULT_SEARCH_OPTIONS,
  text,
  ...options,
})

/** Run a search, gathering its batches into the files it found. */
async function search(job: SearchJob) {
  const batches: SearchBatch[] = []
  const summary = await searchFiles(job, (batch) => batches.push(batch))
  const files: FileSearchResult[] = batches.flatMap((batch) => batch.files)
  return { ...summary, files, batches, paths: files.map((file) => file.path) }
}

describe('searchFiles', () => {
  it('locates every match by line and column, in list order', async () => {
    const root = await workspace({
      'src/a.ts': 'const needle = 1\n\nexport { needle }\n',
      'src/b.ts': 'nothing here\n',
      'README.md': '# Needle\n',
    })
    const result = await search({
      root,
      files: ['README.md', 'src/a.ts', 'src/b.ts'],
      query: query('needle'),
    })
    expect(result.paths).toEqual(['README.md', 'src/a.ts'])
    expect(result.files[1]!.matches.map((m) => [m.line, m.column, m.endColumn])).toEqual([
      [1, 7, 13],
      [3, 10, 16],
    ])
    expect(result).toMatchObject({ matchCount: 3, searchedFiles: 3, skippedFiles: 0 })
    expect(result.stopped).toBeUndefined()
  })

  it('skips binary, media and oversized files, and ignores what is no longer a file', async () => {
    const root = await workspace({
      'text.txt': 'needle',
      'blob.bin': Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]),
      'logo.png': 'needle',
      'big.log': '',
      'dir/inner.txt': 'needle',
    })
    await truncate(join(root, 'big.log'), MAX_TEXT_FILE_BYTES + 1)
    await symlink(join(root, 'text.txt'), join(root, 'link.txt'))
    const result = await search({
      root,
      files: ['big.log', 'blob.bin', 'deleted.txt', 'dir', 'link.txt', 'logo.png', 'text.txt'],
      query: query('needle'),
    })
    expect(result.paths).toEqual(['text.txt'])
    expect(result).toMatchObject({ searchedFiles: 1, skippedFiles: 3 })
  })

  it('never reads outside the root', async () => {
    const root = await workspace({ 'inside/a.txt': 'needle', 'outside.txt': 'needle' })
    const result = await search({
      root: join(root, 'inside'),
      files: ['../outside.txt', 'a.txt', join(root, 'outside.txt')],
      query: query('needle'),
    })
    expect(result.paths).toEqual(['a.txt'])
  })

  it('never reads through a folder that became a link out of the root', async () => {
    const root = await workspace({ 'inside/a.txt': 'needle', 'outside/secret.txt': 'needle' })
    // What git's index still lists as `sub/secret.txt`, after `sub` was
    // replaced by a link.
    await symlink(join(root, 'outside'), join(root, 'inside', 'sub'))
    const result = await search({
      root: join(root, 'inside'),
      files: ['a.txt', 'sub/secret.txt'],
      query: query('needle'),
    })
    expect(result.paths).toEqual(['a.txt'])
  })

  it('reads through a folder linked inside the root', async () => {
    const root = await workspace({ 'real/a.txt': 'needle' })
    await symlink(join(root, 'real'), join(root, 'alias'))
    const result = await search({ root, files: ['alias/a.txt'], query: query('needle') })
    expect(result.paths).toEqual(['alias/a.txt'])
  })

  it('filters the list with include and exclude globs', async () => {
    const root = await workspace({
      'src/a.ts': 'needle',
      'src/a.test.ts': 'needle',
      'docs/a.md': 'needle',
    })
    const files = ['docs/a.md', 'src/a.test.ts', 'src/a.ts']
    const included = await search({ root, files, query: query('needle'), include: 'src' })
    expect(included.paths).toEqual(['src/a.test.ts', 'src/a.ts'])
    const excluded = await search({
      root,
      files,
      query: query('needle'),
      include: 'src',
      exclude: '*.test.ts',
    })
    expect(excluded.paths).toEqual(['src/a.ts'])
  })

  it('stops at the result cap and says so', async () => {
    const root = await workspace({
      'a.txt': 'x '.repeat(MAX_SEARCH_RESULTS - 1),
      'b.txt': 'x x',
      'c.txt': 'x',
    })
    const result = await search({ root, files: ['a.txt', 'b.txt', 'c.txt'], query: query('x') })
    expect(result.matchCount).toBe(MAX_SEARCH_RESULTS)
    expect(result.files.map((file) => file.matches.length)).toEqual([MAX_SEARCH_RESULTS - 1, 1])
    expect(result.stopped).toBe('results')
  })

  it('does not call a search that ends exactly at the cap stopped', async () => {
    const root = await workspace({ 'a.txt': 'x '.repeat(MAX_SEARCH_RESULTS - 1), 'b.txt': 'x' })
    const result = await search({ root, files: ['a.txt', 'b.txt'], query: query('x') })
    expect(result.matchCount).toBe(MAX_SEARCH_RESULTS)
    expect(result.stopped).toBeUndefined()
  })

  it('counts columns without a byte-order mark, as the editor does', async () => {
    const root = await workspace({ 'bom.txt': '﻿needle' })
    const result = await search({ root, files: ['bom.txt'], query: query('needle') })
    expect(result.files[0]!.matches[0]).toMatchObject({ line: 1, column: 1 })
  })

  it('ends lines at CRLF and a lone CR, as the editor does', async () => {
    const root = await workspace({ 'crlf.txt': 'one\r\ntwo\rthree needle\r\n' })
    const result = await search({ root, files: ['crlf.txt'], query: query('needle') })
    expect(result.files[0]!.matches[0]).toMatchObject({
      line: 3,
      column: 7,
      preview: 'three needle',
    })
    const anchored = await search({
      root,
      files: ['crlf.txt'],
      query: query('^two$', { regex: true }),
    })
    expect(anchored.files[0]!.matches[0]).toMatchObject({ line: 2, column: 1 })
  })

  it('answers a bad query or glob with an error instead of searching', async () => {
    const root = await workspace({ 'a.txt': 'needle' })
    const badRegex = await search({ root, files: ['a.txt'], query: query('(', { regex: true }) })
    expect(badRegex.error).toBe('Unterminated group')
    const badGlob = await search({
      root,
      files: ['a.txt'],
      query: query('needle'),
      include: '{a',
    })
    expect(badGlob.error).toBe('Unclosed "{" in {a')
    expect(badGlob.searchedFiles).toBe(0)
    expect(badGlob.batches).toEqual([])
  })

  it('reports progress after every read batch, found files or not', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 30; i++) files[`f${String(i).padStart(2, '0')}.txt`] = `needle ${i}`
    files['z.txt'] = 'nothing'
    const root = await workspace(files)
    const result = await search({ root, files: Object.keys(files), query: query('needle') })
    expect(result.paths).toHaveLength(30)
    expect(result.batches.length).toBeGreaterThan(1)
    expect(result.batches.map((batch) => batch.searchedFiles)).toEqual(
      [...result.batches.map((batch) => batch.searchedFiles)].sort((a, b) => a - b),
    )
    expect(result.batches.at(-1)!.searchedFiles).toBe(31)
  })
})
