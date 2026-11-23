import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWitness, takeWitness, witnessChanges, writeWitness } from './witness'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'm3-witness-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the session witness', () => {
  it('sees no change when nothing was touched, and records missing files', () => {
    const a = join(root, 'a.jsonl')
    writeFileSync(a, '{}\n')
    const paths = [a, join(root, 'gone.jsonl'), a]
    const before = takeWitness(paths)
    expect(before.entries).toHaveLength(2)
    expect(before.entries.find((e) => e.path.endsWith('gone.jsonl'))).toEqual({
      path: join(root, 'gone.jsonl'),
      missing: true,
    })
    expect(witnessChanges(before, takeWitness(paths))).toEqual([])
  })

  it('sees an append, a touch, a replacement and a file that appeared', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => join(root, `${n}.jsonl`))
    for (const path of [a!, b!, c!]) writeFileSync(path, '{}\n')
    const before = takeWitness([a!, b!, c!, d!])
    appendFileSync(a!, '{}\n')
    utimesSync(b!, new Date(1000), new Date(1000))
    rmSync(c!)
    writeFileSync(c!, '{}\n')
    writeFileSync(d!, '{}\n')
    expect(witnessChanges(before, takeWitness([a!, b!, c!, d!]))).toEqual([a, b, c, d])
  })

  it('round-trips through the backup folder', () => {
    writeFileSync(join(root, 'a.jsonl'), '{}\n')
    const witness = takeWitness([join(root, 'a.jsonl')])
    writeWitness(root, witness)
    expect(readWitness(root)).toEqual(witness)
  })
})
