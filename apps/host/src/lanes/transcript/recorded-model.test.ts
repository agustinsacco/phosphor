import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assistantMessage,
  CLAUDE_LANE,
  modelChange,
  piTranscript,
  userMessage,
} from '../__fixtures__/pi-transcript'
import { readRecordedModel } from './recorded-model'

let directory: string
let root: string
let path: string

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'phosphor-recorded-model-')))
  root = join(directory, 'sessions')
  mkdirSync(root)
  path = join(root, 'lane.jsonl')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

const read = (tailBytes?: number) => readRecordedModel(path, root, tailBytes)

describe('readRecordedModel', () => {
  it('reads the model the lane resumes with', () => {
    writeFileSync(path, piTranscript(CLAUDE_LANE))
    expect(read()).toMatchObject({
      kind: 'model',
      model: { provider: 'pi-claude-cli', id: 'claude-opus-5' },
    })
  })

  it('takes the entry nearest the leaf: a later model change, else the last answer', () => {
    writeFileSync(
      path,
      piTranscript([
        modelChange('m1', 'anthropic', 'old'),
        assistantMessage('a1', 'anthropic', 'old'),
        modelChange('m2', 'openai-codex', 'gpt-5'),
      ]),
    )
    expect(read()).toMatchObject({ model: { provider: 'openai-codex', id: 'gpt-5' } })
    writeFileSync(path, piTranscript([userMessage('u1', 'hi'), assistantMessage('a1', 'x', 'y')]))
    expect(read()).toMatchObject({ model: { provider: 'x', id: 'y' } })
  })

  it('follows the leaf’s branch, not the file’s last answer', () => {
    writeFileSync(
      path,
      piTranscript([
        modelChange('m1', 'anthropic', 'kept'),
        userMessage('u1', 'first try'),
        assistantMessage('a1', 'openai-codex', 'abandoned'),
        { ...userMessage('u2', 'second try'), parentId: 'm1' },
      ]),
    )
    expect(read()).toMatchObject({ model: { provider: 'anthropic', id: 'kept' } })
  })

  it('reports none for a lane that never picked or used a model', () => {
    writeFileSync(path, piTranscript([userMessage('u1', 'hi')]))
    expect(read()).toMatchObject({ kind: 'none' })
  })

  it('reports none only once the walk reaches the branch’s root or the file’s start', () => {
    writeFileSync(path, piTranscript([userMessage('u1', 'hi'), userMessage('u2', 'again')]))
    expect(read(1024)).toMatchObject({ kind: 'none' })
    const headerless = `${JSON.stringify({ type: 'message', id: 'u1', parentId: 'x' })}\n`
    writeFileSync(path, headerless)
    expect(read()).toMatchObject({ kind: 'none' })
    writeFileSync(path, piTranscript([userMessage('u1', 'x'.repeat(4096))]))
    expect(read(1024)).toMatchObject({ kind: 'capped' })
  })

  it('skips a torn last line', () => {
    writeFileSync(path, `${piTranscript(CLAUDE_LANE)}{"type":"message","id":"a2","par`)
    expect(read()).toMatchObject({ model: { provider: 'pi-claude-cli', id: 'claude-opus-5' } })
  })

  it('reads only its tail, however large the file', () => {
    const big = 'x'.repeat(64 * 1024)
    writeFileSync(
      path,
      piTranscript([modelChange('m1', 'anthropic', 'early'), userMessage('u1', big)]),
    )
    // Stopping at the cap proves nothing about the branch's model.
    const result = read(16 * 1024)
    expect(result).toEqual({ kind: 'capped', bytes: 16 * 1024 })
    expect(read()).toMatchObject({ model: { provider: 'anthropic', id: 'early' } })
  })

  it('refuses a missing file, a symlink and a file outside pi’s sessions', () => {
    expect(read()).toMatchObject({ kind: 'unreadable' })
    const outside = join(directory, 'outside.jsonl')
    writeFileSync(outside, piTranscript(CLAUDE_LANE))
    symlinkSync(outside, path)
    expect(read()).toMatchObject({ kind: 'unreadable' })
    expect(readRecordedModel(outside, root)).toMatchObject({ kind: 'unreadable' })
  })

  it('refuses a model the lane store could not hold', () => {
    writeFileSync(path, piTranscript([modelChange('m1', 'p', 'm'.repeat(129))]))
    expect(read()).toMatchObject({ kind: 'none' })
  })

  it('refuses a model the lane store’s validators refuse, such as one with a control character', () => {
    writeFileSync(path, piTranscript([modelChange('m1', 'anthropic', 'claude\nopus')]))
    expect(read()).toMatchObject({ kind: 'none' })
    writeFileSync(path, piTranscript([assistantMessage('a1', 'open\u2028ai', 'gpt-5')]))
    expect(read()).toMatchObject({ kind: 'none' })
  })

  it('reads a tail that is one long record without copying it chunk after chunk', () => {
    const long = 'x'.repeat(3 * 1024 * 1024)
    writeFileSync(
      path,
      piTranscript([modelChange('m1', 'anthropic', 'early'), userMessage('u1', long)]),
    )
    const concat = vi.spyOn(Buffer, 'concat')
    try {
      expect(read()).toMatchObject({ model: { provider: 'anthropic', id: 'early' } })
      const copied = concat.mock.results.reduce(
        (sum, result) => sum + (result.value as Buffer).length,
        0,
      )
      expect(copied).toBeLessThanOrEqual(long.length)
    } finally {
      concat.mockRestore()
    }
  })
})
