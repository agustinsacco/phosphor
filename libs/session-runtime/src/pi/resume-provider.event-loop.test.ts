import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, readSync, rmSync } from 'node:fs'
import type * as Fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendEntries,
  writeLargeTranscript,
  type LargeTranscriptBulk,
} from './__fixtures__/large-transcript'
import { resumeProvider } from './resume-provider'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  return { ...actual, readSync: vi.fn(actual.readSync) }
})

const YIELD_BYTES = 16 * 1024 * 1024
const BULK_MIB = 40
let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'phosphor-resume-provider-loop-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Reads the transcript's provider while counting the bytes read between event-loop turns. */
async function scan(bulk: LargeTranscriptBulk, last: unknown) {
  const path = join(root, `${bulk}.jsonl`)
  writeLargeTranscript(path, BULK_MIB, bulk)
  appendEntries(path, [last])
  const actual = await vi.importActual<typeof Fs>('node:fs')
  let bytes = 0
  let timerAt: number | undefined
  let turnAt = 0
  let widest = 0
  let scanning = true
  const turn = () => {
    widest = Math.max(widest, bytes - turnAt)
    turnAt = bytes
    if (scanning) setImmediate(turn)
  }
  vi.mocked(readSync).mockImplementation(((...args: Parameters<typeof actual.readSync>) => {
    // Scheduled once reading began, so the opening awaits cannot run it.
    if (bytes === 0) {
      setTimeout(() => (timerAt = bytes), 0)
      setImmediate(turn)
    }
    const count = actual.readSync(...args)
    bytes += count
    return count
  }) as typeof readSync)
  try {
    const provider = await resumeProvider(path)
    turn()
    return { provider, bytes, timerAt, widest }
  } finally {
    scanning = false
    vi.mocked(readSync).mockImplementation(actual.readSync)
  }
}

it('lets a timer run during a long version 1 walk over ordinary entries', async () => {
  const result = await scan('legacy', { type: 'message', message: { role: 'user', content: '' } })
  expect(result.provider).toBe('first-provider')
  expect(result.bytes).toBeGreaterThan(BULK_MIB * 1024 * 1024)
  expect(result.timerAt).toBeLessThan(result.bytes)
  expect(result.widest).toBeLessThanOrEqual(YIELD_BYTES)
})

it('lets a timer run while a parent walk skips torn and blank lines', async () => {
  const result = await scan('torn', { type: 'custom', id: 'c1', parentId: 'm0' })
  expect(result.provider).toBe('first-provider')
  expect(result.bytes).toBeGreaterThan(BULK_MIB * 1024 * 1024)
  expect(result.timerAt).toBeLessThan(result.bytes)
  expect(result.widest).toBeLessThanOrEqual(YIELD_BYTES)
})
