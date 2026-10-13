import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPromptCorpus } from './prompt-corpus'

let dir = ''
let file = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phosphor-prompts-'))
  file = join(dir, 'writing', 'prompts.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const lines = (): string[] => readFileSync(file, 'utf8').trim().split('\n')

describe('prompt corpus', () => {
  it('keeps sent prompts across instances, oldest first', async () => {
    const first = createPromptCorpus(() => file)
    await first.record('  ok good lets open a PR  ')
    await first.record('run the tests')
    expect(await createPromptCorpus(() => file).list()).toEqual([
      'ok good lets open a PR',
      'run the tests',
    ])
  })

  it('writes a file only its owner can read', async () => {
    await createPromptCorpus(() => file).record('private prompt')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('learns nothing from commands, empty text or paste-sized prompts', async () => {
    const corpus = createPromptCorpus(() => file)
    for (const text of ['/compact', '!ls -la', '   ', 'x'.repeat(2001)]) await corpus.record(text)
    expect(await corpus.list()).toEqual([])
    expect(existsSync(file)).toBe(false)
  })

  it('keeps the newest prompts past the limit and rewrites the file at twice it', async () => {
    const corpus = createPromptCorpus(() => file, 3)
    for (let n = 1; n <= 6; n++) await corpus.record(`prompt ${n}`)
    expect(await corpus.list()).toEqual(['prompt 4', 'prompt 5', 'prompt 6'])
    expect(lines()).toHaveLength(6)
    await corpus.record('prompt 7')
    expect(lines()).toHaveLength(3)
    expect(await createPromptCorpus(() => file, 3).list()).toEqual([
      'prompt 5',
      'prompt 6',
      'prompt 7',
    ])
  })

  it('skips a torn line left by a crash mid-append', async () => {
    await createPromptCorpus(() => file).record('whole')
    writeFileSync(file, readFileSync(file, 'utf8') + '{"t":"half', { flag: 'w' })
    expect(await createPromptCorpus(() => file).list()).toEqual(['whole'])
  })

  it('forgets everything on clear, even with an append in flight', async () => {
    const corpus = createPromptCorpus(() => file)
    await corpus.record('one')
    const pending = corpus.record('two')
    await corpus.clear()
    await pending
    expect(await corpus.list()).toEqual([])
    expect(existsSync(file)).toBe(false)
  })
})
