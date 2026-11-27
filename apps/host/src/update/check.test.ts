import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startReleaseCheck } from './check'

const MIN = 60_000
const HOUR = 60 * MIN

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse('2026-11-26T12:00:00.000Z'))
})
afterEach(() => vi.useRealTimers())

function checker(random: () => number, latest = vi.fn(async () => '1.3.0')) {
  const log = vi.fn()
  const check = startReleaseCheck({ installed: '1.2.0', latest, log, random })
  return { check, latest, log }
}

it('checks first between 2 and 5 minutes after start, then about every 6 hours', async () => {
  const early = checker(() => 0)
  await vi.advanceTimersByTimeAsync(2 * MIN - 1)
  expect(early.latest).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(early.latest).toHaveBeenCalledTimes(1)
  expect(early.check.report()).toEqual({
    available: '1.3.0',
    checkedAt: '2026-11-26T12:02:00.000Z',
  })
  // The next check is 6 hours less up to 30 minutes of jitter.
  await vi.advanceTimersByTimeAsync(5.5 * HOUR - 1)
  expect(early.latest).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(early.latest).toHaveBeenCalledTimes(2)
  early.check.stop()

  const late = checker(() => 1)
  await vi.advanceTimersByTimeAsync(5 * MIN - 1)
  expect(late.latest).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(late.latest).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(6.5 * HOUR)
  expect(late.latest).toHaveBeenCalledTimes(2)
  late.check.stop()
  await vi.advanceTimersByTimeAsync(24 * HOUR)
  expect(late.latest).toHaveBeenCalledTimes(2)
})

it('reports nothing available when the newest signed release is the installed one', async () => {
  const { check } = checker(
    () => 0,
    vi.fn(async () => '1.2.0'),
  )
  expect(check.report()).toEqual({})
  await vi.advanceTimersByTimeAsync(2 * MIN)
  expect(check.report()).toEqual({ checkedAt: '2026-11-26T12:02:00.000Z' })
  check.stop()
})

it('keeps a failed check silent: logged, the last good answer kept', async () => {
  const latest = vi.fn(async () => '1.3.0')
  const { check, log } = checker(() => 0, latest)
  await vi.advanceTimersByTimeAsync(2 * MIN)
  latest.mockRejectedValueOnce(new Error('offline'))
  await vi.advanceTimersByTimeAsync(5.5 * HOUR)
  expect(latest).toHaveBeenCalledTimes(2)
  expect(check.report()).toEqual({
    available: '1.3.0',
    checkedAt: '2026-11-26T12:02:00.000Z',
  })
  expect(log).toHaveBeenCalledWith('host', 'update check failed', { error: 'offline' })
  check.stop()
})

it('refreshes in the background when a read finds the answer older than 30 minutes', async () => {
  let finish: (version: string) => void = () => {}
  const latest = vi.fn(async () => '1.3.0')
  const { check } = checker(() => 0, latest)
  await vi.advanceTimersByTimeAsync(2 * MIN)
  await vi.advanceTimersByTimeAsync(29 * MIN)
  check.report()
  expect(latest).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1 * MIN)
  latest.mockImplementationOnce(() => new Promise<string>((resolve) => (finish = resolve)))
  // The read never waits: it answers with what it has and starts one check.
  expect(check.report()).toEqual({ available: '1.3.0', checkedAt: '2026-11-26T12:02:00.000Z' })
  check.report()
  expect(latest).toHaveBeenCalledTimes(2)
  finish('1.4.0')
  await vi.advanceTimersByTimeAsync(0)
  expect(check.report()).toEqual({ available: '1.4.0', checkedAt: '2026-11-26T12:32:00.000Z' })
  check.stop()
})

it('never refreshes from a read before the first scheduled check', async () => {
  const { check, latest } = checker(() => 1)
  await vi.advanceTimersByTimeAsync(4 * MIN)
  check.report()
  expect(latest).not.toHaveBeenCalled()
  check.stop()
})
