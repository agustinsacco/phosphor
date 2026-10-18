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
import { createPromptCorpus } from './prompt-corpus'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phosphor-corpus-characterization-'))
  file = join(dir, 'prompts.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const savedPrompts = (): string[] =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { t: string }).t)

describe('prompt corpus characterization', () => {
  it('serializes queued records, clear, list and subsequent records in call order', async () => {
    const corpus = createPromptCorpus(() => file)
    const first = corpus.record('first')
    const second = corpus.record('second')
    const beforeClear = corpus.list()
    const clear = corpus.clear()
    const afterClear = corpus.list()
    const last = corpus.record('last')
    await Promise.all([first, second, clear, last])
    expect(await beforeClear).toEqual(['first', 'second'])
    expect(await afterClear).toEqual([])
    expect(await corpus.list()).toEqual(['last'])
    expect(savedPrompts()).toEqual(['last'])
  })

  it('rejects a failed append without poisoning the chain or undoing its cached prompt', async () => {
    mkdirSync(file)
    const corpus = createPromptCorpus(() => file)
    const failed = corpus.record('failed append')
    const cached = corpus.list()
    await expect(failed).rejects.toMatchObject({ code: 'EISDIR' })
    expect(await cached).toEqual(['failed append'])
    rmSync(file, { recursive: true })
    await corpus.record('next append')
    expect(await corpus.list()).toEqual(['failed append', 'next append'])
    expect(savedPrompts()).toEqual(['next append'])
  })

  it('rejects a failed clear but resets the cache and permits queued operations', async () => {
    const corpus = createPromptCorpus(() => file)
    await corpus.record('old')
    rmSync(file)
    mkdirSync(file)
    const failed = corpus.clear()
    const cached = corpus.list()
    await expect(failed).rejects.toBeDefined()
    expect(await cached).toEqual([])
    rmSync(file, { recursive: true })
    await corpus.record('new')
    expect(savedPrompts()).toEqual(['new'])
  })

  it('isolates a torn last line before appending unchanged JSONL entries', async () => {
    writeFileSync(file, '{"t":"whole","at":1}\n{"t":"torn')
    const corpus = createPromptCorpus(() => file)
    expect(await corpus.list()).toEqual(['whole'])
    const before = Date.now()
    await corpus.record('  next  ')
    const raw = readFileSync(file, 'utf8')
    expect(raw.startsWith('{"t":"whole","at":1}\n{"t":"torn\n')).toBe(true)
    expect(raw.endsWith('\n')).toBe(true)
    const entry: unknown = JSON.parse(raw.trim().split('\n').at(-1)!)
    expect(entry).toEqual({ t: 'next', at: expect.any(Number) })
    expect((entry as { at: number }).at).toBeGreaterThanOrEqual(before)
    expect((entry as { at: number }).at).toBeLessThanOrEqual(Date.now())
    expect(await createPromptCorpus(() => file).list()).toEqual(['whole', 'next'])
  })

  it('rewrites only after twice the limit, retaining the newest prompts', async () => {
    const corpus = createPromptCorpus(() => file, 2)
    for (const text of ['one', 'two', 'three', 'four']) await corpus.record(text)
    expect(savedPrompts()).toEqual(['one', 'two', 'three', 'four'])
    expect(await corpus.list()).toEqual(['three', 'four'])
    await corpus.record('five')
    expect(savedPrompts()).toEqual(['four', 'five'])
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(await createPromptCorpus(() => file, 2).list()).toEqual(['four', 'five'])
  })

  it('creates owner-only files both on append and on replacement', async () => {
    const corpus = createPromptCorpus(() => file, 1)
    await corpus.record('one')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    await corpus.record('two')
    await corpus.record('three')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(savedPrompts()).toEqual(['three'])
  })

  it('returns copies rather than exposing the cached prompt list', async () => {
    const corpus = createPromptCorpus(() => file)
    await corpus.record('saved')
    const list = await corpus.list()
    list[0] = 'changed'
    list.push('injected')
    expect(await corpus.list()).toEqual(['saved'])
    expect(savedPrompts()).toEqual(['saved'])
  })

  it('resolves paths lazily for load, writes and clear, not for cached reads or ignored text', async () => {
    let calls = 0
    let path = file
    const corpus = createPromptCorpus(() => {
      calls += 1
      return path
    })
    expect(calls).toBe(0)
    await corpus.record('/ignored')
    expect(calls).toBe(0)
    expect(await corpus.list()).toEqual([])
    expect(calls).toBe(1)
    await corpus.list()
    expect(calls).toBe(1)
    path = join(dir, 'later.jsonl')
    await corpus.record('later')
    expect(calls).toBe(2)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(path)).toBe(true)
    await corpus.clear()
    expect(calls).toBe(3)
    expect(existsSync(path)).toBe(false)
  })
})
