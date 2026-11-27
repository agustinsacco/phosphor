import { appendFileSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearSubagentPrCache } from '@phosphor/session-runtime/pi/lane-pr-runs'
import * as fold from '@phosphor/session-runtime/pi/session-fold'
import { createLanePrReader, LANE_PR_FOLD_LIMITS } from './lane-pr-fold'

// How a Host lane's PR fold resumes: a proven append continues, anything else
// folds from the start, and a file over the byte cap is never folded.

let dir: string
const line = (value: object) => JSON.stringify(value) + '\n'
const header = { type: 'session', id: 'lane', cwd: '/repo' }
const user = (text: string) => ({ type: 'message', message: { role: 'user', content: text } })
const pr = (n: number) => line(user(`https://github.com/acme/app/pull/${n}`))
const ref = (number: number) => ({ host: 'github.com', owner: 'acme', repo: 'app', number })
const starts = (spy: { mock: { calls: unknown[][] } }, file: string) =>
  spy.mock.calls.filter((call) => call[0] === file).map((call) => [call[1], call[3]])

beforeEach(() => {
  clearSubagentPrCache()
  dir = mkdtempSync(join(tmpdir(), 'host-lane-prs-resume-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

it('folds from the start after a rewrite and after a truncation', async () => {
  const file = join(dir, 'lane.jsonl')
  writeFileSync(file, line(header) + pr(1) + pr(2))
  const read = createLanePrReader()
  expect(await read(file)).toMatchObject({ mentioned: [ref(1), ref(2)] })
  const reads = vi.spyOn(fold, 'readLinesFrom')
  writeFileSync(file, line(header) + pr(3) + pr(4) + pr(5))
  expect(await read(file)).toMatchObject({ mentioned: [ref(3), ref(4), ref(5)] })
  truncateSync(file, (line(header) + pr(3)).length)
  expect(await read(file)).toMatchObject({ mentioned: [ref(3)] })
  const cap = LANE_PR_FOLD_LIMITS.fileBytes
  expect(starts(reads, file)).toEqual([
    [0, cap],
    [0, cap],
  ])
})

it('continues a proven append with the byte cap', async () => {
  const file = join(dir, 'lane.jsonl')
  writeFileSync(file, line(header) + pr(1))
  const read = createLanePrReader()
  await read(file)
  const size = statSync(file).size
  const reads = vi.spyOn(fold, 'readLinesFrom')
  appendFileSync(file, pr(2))
  expect(await read(file)).toMatchObject({ mentioned: [ref(1), ref(2)] })
  expect(starts(reads, file)).toEqual([[size, LANE_PR_FOLD_LIMITS.fileBytes]])
})

it('keeps sixteen resumable folds, dropping the least recently used', async () => {
  const read = createLanePrReader()
  const files = Array.from({ length: 17 }, (_, i) => join(dir, `lane-${i}.jsonl`))
  for (const file of files) {
    writeFileSync(file, line(header) + pr(1))
    await read(file)
  }
  const size = statSync(files[0]!).size
  const reads = vi.spyOn(fold, 'readLinesFrom')
  // Newest first, so no refold evicts a resume before it is used.
  for (const file of [...files].reverse()) {
    appendFileSync(file, pr(2))
    await read(file)
  }
  expect(starts(reads, files[0]!)).toEqual([[0, LANE_PR_FOLD_LIMITS.fileBytes]])
  for (const file of files.slice(1))
    expect(starts(reads, file)).toEqual([[size, LANE_PR_FOLD_LIMITS.fileBytes]])
})

it('never folds a file over the byte cap, and answers it undefined', async () => {
  const file = join(dir, 'lane.jsonl')
  writeFileSync(file, line(header) + pr(1))
  truncateSync(file, LANE_PR_FOLD_LIMITS.fileBytes + 1)
  const reads = vi.spyOn(fold, 'readLinesFrom')
  expect(await createLanePrReader()(file)).toBeUndefined()
  expect(reads).not.toHaveBeenCalled()
})

it('folds from the start when a resumed read fails, and throws when that fails too', async () => {
  const file = join(dir, 'lane.jsonl')
  writeFileSync(file, line(header) + pr(1))
  const read = createLanePrReader()
  await read(file)
  appendFileSync(file, pr(2))
  const reads = vi
    .spyOn(fold, 'readLinesFrom')
    .mockRejectedValueOnce(new Error('session-too-large'))
  expect(await read(file)).toMatchObject({ mentioned: [ref(1), ref(2)] })
  expect(starts(reads, file).map(([start]) => start)).toEqual([
    statSync(file).size - pr(2).length,
    0,
  ])
  appendFileSync(file, pr(3))
  reads.mockRejectedValue(new Error('session-too-large'))
  await expect(read(file)).rejects.toThrow('session-too-large')
})
