import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendPrompt, clearCorpus, loadCorpus, type CorpusState } from './corpus-storage'

let dir: string
let file: string
let state: CorpusState

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phosphor-corpus-storage-'))
  file = join(dir, 'prompts.jsonl')
  state = { prompts: null, fileLines: 0, torn: false, chain: Promise.resolve() }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const entries = (path: string): unknown[] =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown)

describe('corpus storage', () => {
  it('skips malformed and non-text entries while counting nonblank lines for rewrites', async () => {
    writeFileSync(
      file,
      [
        '{"t":"old","at":1}',
        'broken',
        'null',
        '{}',
        '{"t":4}',
        '{"t":""}',
        '  ',
        '{"t":" newest "}',
        '{"t":"half',
      ].join('\n'),
    )
    expect(await loadCorpus(state, () => file, 10)).toEqual(['old', ' newest '])
    expect(state.fileLines).toBe(8)
    expect(state.torn).toBe(true)
  })

  it('caps loaded prompts, oldest first, without rewriting or reloading the file', async () => {
    const raw = ['one', 'two', 'three'].map((t) => JSON.stringify({ t })).join('\n') + '\n'
    writeFileSync(file, raw)
    const loaded = await loadCorpus(state, () => file, 2)
    expect(loaded).toEqual(['two', 'three'])
    expect(state.fileLines).toBe(3)
    expect(state.torn).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(raw)
    expect(
      await loadCorpus(
        state,
        () => {
          throw new Error('cached load must not resolve a path')
        },
        2,
      ),
    ).toBe(loaded)
  })

  it('caches an empty corpus on read or path-resolution errors', async () => {
    expect(await loadCorpus(state, () => file, 2)).toEqual([])
    writeFileSync(file, '{"t":"arrived later"}\n')
    expect(await loadCorpus(state, () => file, 2)).toEqual([])
    state.prompts = null
    expect(
      await loadCorpus(
        state,
        () => {
          throw new Error('path unavailable')
        },
        2,
      ),
    ).toEqual([])
    expect(state.fileLines).toBe(0)
    expect(state.torn).toBe(false)
  })

  it('preserves a complete final entry without LF and isolates it on the next append', async () => {
    writeFileSync(file, '{"t":"whole"}')
    expect(await loadCorpus(state, () => file, 3)).toEqual(['whole'])
    expect(state.torn).toBe(true)
    await appendPrompt(state, () => file, 3, '  next  ')
    expect(entries(file)).toEqual([{ t: 'whole' }, { t: 'next', at: expect.any(Number) }])
    expect(state.prompts).toEqual(['whole', 'next'])
    expect(state.fileLines).toBe(2)
    expect(state.torn).toBe(false)
  })

  it('counts invalid lines toward compaction and replaces the file with capped JSONL', async () => {
    writeFileSync(file, '{"t":"old"}\nbroken\n{"t":"new"}\n{"t":"torn')
    await appendPrompt(state, () => file, 2, 'latest')
    expect(entries(file)).toEqual([
      { t: 'new', at: expect.any(Number) },
      { t: 'latest', at: expect.any(Number) },
    ])
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(state.prompts).toEqual(['new', 'latest'])
    expect(state.fileLines).toBe(2)
    expect(state.torn).toBe(false)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('leaves rewrite counters unchanged on rename failure and can retry the replacement', async () => {
    writeFileSync(file, '{"t":"one"}\n{"t":"two"}')
    await loadCorpus(state, () => file, 1)
    rmSync(file)
    mkdirSync(file)
    await expect(appendPrompt(state, () => file, 1, 'three')).rejects.toBeDefined()
    expect(statSync(file).isDirectory()).toBe(true)
    expect(entries(`${file}.tmp`)).toEqual([{ t: 'three', at: expect.any(Number) }])
    expect(state.prompts).toEqual(['three'])
    expect(state.fileLines).toBe(2)
    expect(state.torn).toBe(true)
    rmSync(file, { recursive: true })
    await appendPrompt(state, () => file, 1, 'four')
    expect(entries(file)).toEqual([{ t: 'four', at: expect.any(Number) }])
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(state.fileLines).toBe(1)
    expect(state.torn).toBe(false)
  })

  it('resolves the path independently for initial load, append and clear', async () => {
    const destination = join(dir, 'later', 'prompts.jsonl')
    writeFileSync(file, '{"t":"loaded"}\n')
    const paths: string[] = []
    const filePath = (): string => {
      const path = paths.length === 0 ? file : destination
      paths.push(path)
      return path
    }
    expect(paths).toEqual([])
    await appendPrompt(state, filePath, 3, 'written')
    expect(paths).toEqual([file, destination])
    expect(state.prompts).toEqual(['loaded', 'written'])
    expect(entries(destination)).toEqual([{ t: 'written', at: expect.any(Number) }])
    await clearCorpus(state, filePath)
    expect(paths).toEqual([file, destination, destination])
    expect(existsSync(file)).toBe(true)
    expect(existsSync(destination)).toBe(false)
    expect(state.prompts).toEqual([])
    expect(state.fileLines).toBe(0)
    expect(state.torn).toBe(false)
    await clearCorpus(state, filePath)
  })
})
