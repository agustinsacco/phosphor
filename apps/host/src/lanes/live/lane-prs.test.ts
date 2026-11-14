import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LanePrSignals } from '@phosphor/shared/models'
import { createLanePrSignals } from './lane-prs'

const signals = (number: number): LanePrSignals => ({
  opened: [{ host: 'github.com', owner: 'acme', repo: 'app', number }],
  branches: [],
  reviewing: [],
  mentioned: [],
  pinned: [],
  hidden: [],
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function setup(read = vi.fn(async (_file: string) => signals(1) as LanePrSignals | undefined)) {
  const changed = vi.fn()
  const prs = createLanePrSignals({ read, changed, now: Date.now, intervalMs: 5_000 })
  return { read, changed, prs }
}

it('answers from the last read, reads in the background and batches what changed', async () => {
  const { read, changed, prs } = setup()
  expect(prs.signalsFor('a', '/a.jsonl')).toBeUndefined()
  expect(prs.signalsFor('b', '/b.jsonl')).toBeUndefined()
  await vi.advanceTimersByTimeAsync(250)
  expect(read.mock.calls.map(([file]) => file)).toStrictEqual(['/a.jsonl', '/b.jsonl'])
  expect(changed).toHaveBeenCalledExactlyOnceWith(['a', 'b'])
  expect(prs.signalsFor('a', '/a.jsonl')).toStrictEqual(signals(1))
})

it('reads one lane at most once per interval, and once more at its end when asked inside it', async () => {
  const { read, prs } = setup()
  prs.signalsFor('a', '/a.jsonl')
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < 10; i++) prs.signalsFor('a', '/a.jsonl')
  await vi.advanceTimersByTimeAsync(4_000)
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(read).toHaveBeenCalledTimes(2)
})

it('announces nothing when the answer is unchanged, and keeps the last answer through a failure', async () => {
  const read = vi.fn(async (_file: string) => signals(1) as LanePrSignals | undefined)
  const { changed, prs } = setup(read)
  prs.signalsFor('a', '/a.jsonl')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(changed).toHaveBeenCalledTimes(1)
  prs.signalsFor('a', '/a.jsonl')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(changed).toHaveBeenCalledTimes(1)
  read.mockRejectedValueOnce(new Error('EACCES'))
  prs.signalsFor('a', '/a.jsonl')
  await vi.advanceTimersByTimeAsync(5_000)
  read.mockResolvedValueOnce(undefined)
  expect(prs.signalsFor('a', '/a.jsonl')).toStrictEqual(signals(1))
  expect(changed).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(0)
  expect(prs.signalsFor('a', '/a.jsonl')).toBeUndefined()
  await vi.advanceTimersByTimeAsync(250)
  expect(changed).toHaveBeenCalledTimes(2)
})

it('reads a few lanes at a time', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const read = vi.fn(async () => {
    await gate
    return undefined
  })
  const { prs } = setup(read)
  for (let i = 0; i < 10; i++) prs.signalsFor(`l${i}`, `/l${i}.jsonl`)
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(4)
  release()
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(10)
})

it('forgets a lane, a lane without a file, and a lane whose file changed', async () => {
  const { read, changed, prs } = setup()
  prs.signalsFor('a', '/a.jsonl')
  await vi.advanceTimersByTimeAsync(250)
  expect(prs.signalsFor('a', null)).toBeUndefined()
  expect(prs.signalsFor('a', '/moved.jsonl')).toBeUndefined()
  await vi.advanceTimersByTimeAsync(250)
  expect(read).toHaveBeenLastCalledWith('/moved.jsonl')
  prs.forget('a')
  prs.signalsFor('a', '/moved.jsonl')
  await vi.advanceTimersByTimeAsync(250)
  expect(read).toHaveBeenCalledTimes(3)
  expect(changed).toHaveBeenCalledTimes(3)
})
