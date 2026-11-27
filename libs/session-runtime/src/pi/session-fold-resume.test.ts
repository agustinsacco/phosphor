import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createResumableFolds, touchLru } from './session-fold-resume'

let dir: string
const line = (value: object) => JSON.stringify(value) + '\n'
const header = line({ type: 'session', id: 's', cwd: '/w' })
const user = line({ type: 'message', message: { role: 'user', content: 'hi' } })
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fold-resume-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('touchLru', () => {
  it('re-sets a hit at the back and evicts from the front', () => {
    const cache = new Map([
      ['a', 1],
      ['b', 2],
    ])
    touchLru(cache, 'a', 1, 2)
    touchLru(cache, 'c', 3, 2)
    expect([...cache.keys()]).toEqual(['a', 'c'])
  })
})

describe('createResumableFolds', () => {
  it('continues a grown file, and keeps no resume for a null answer', async () => {
    const file = join(dir, 's.jsonl')
    writeFileSync(file, header + user)
    const folds = createResumableFolds(4)
    expect(
      await folds.fold(file, statSync(file).size, (s) => Promise.resolve(s.userMessages)),
    ).toBe(1)
    appendFileSync(file, user)
    const counted = await folds.fold(file, statSync(file).size, (s) =>
      Promise.resolve(s.userMessages === 2 ? null : s.userMessages),
    )
    expect(counted).toBeNull()
    appendFileSync(file, user)
    // The null answer kept the first resume: the fold continues from there.
    expect(
      await folds.fold(file, statSync(file).size, (s) => Promise.resolve(s.userMessages)),
    ).toBe(3)
    folds.forget(file)
    expect(
      await folds.fold(file, statSync(file).size, (s) => Promise.resolve(s.userMessages)),
    ).toBe(3)
  })

  it('throws past its byte cap', async () => {
    const file = join(dir, 's.jsonl')
    writeFileSync(file, header + user)
    const folds = createResumableFolds(4, 8)
    await expect(folds.fold(file, statSync(file).size, (s) => Promise.resolve(s))).rejects.toThrow(
      'session-too-large',
    )
  })
})
