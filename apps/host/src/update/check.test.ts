import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localReleaseMirror } from '@phosphor/session-runtime/host-install/__fixtures__/local-release'
import { newestRelease, startReleaseCheck } from './check'

const MIN = 60_000
const HOUR = 60 * MIN

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse('2026-11-26T12:00:00.000Z'))
})
afterEach(() => vi.useRealTimers())

function checker(
  random: () => number,
  latest = vi.fn<(signal: AbortSignal) => Promise<string | undefined>>(async () => '1.3.0'),
) {
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

it('clears an offer when the newest release for this machine is older or absent', async () => {
  const latest = vi.fn<(signal: AbortSignal) => Promise<string | undefined>>(async () => '1.3.0')
  const { check } = checker(() => 0, latest)
  await vi.advanceTimersByTimeAsync(2 * MIN)
  expect(check.report().available).toBe('1.3.0')
  // A withdrawn release: the manifest now names an older version than the one running.
  latest.mockResolvedValueOnce('1.1.0')
  await vi.advanceTimersByTimeAsync(5.5 * HOUR)
  expect(check.report()).toEqual({ checkedAt: '2026-11-26T17:32:00.000Z' })
  latest.mockResolvedValueOnce('1.3.0')
  await vi.advanceTimersByTimeAsync(5.5 * HOUR)
  latest.mockResolvedValueOnce(undefined)
  await vi.advanceTimersByTimeAsync(5.5 * HOUR)
  expect(check.report()).toEqual({ checkedAt: '2026-11-27T04:32:00.000Z' })
  check.stop()
})

it('reads the v2 manifest for this machine’s target and falls back to v1', async () => {
  vi.useRealTimers()
  const root = mkdtempSync(join(tmpdir(), 'release-check-'))
  try {
    const mirror = localReleaseMirror(root)
    const source = { env: mirror.env, keys: mirror.keys }
    const signal = new AbortController().signal
    mirror.publish({ version: '1.3.0', targets: ['darwin-arm64', 'darwin-x64', 'linux-x64'] })
    expect(await newestRelease(source, 'linux-x64', signal)).toBe('1.3.0')
    expect(await newestRelease(source, 'linux-arm64', signal)).toBeUndefined()
    // An older release is an answer, not a failure: the updater's downgrade guard stays its own.
    mirror.publish({ version: '1.0.0', targets: ['darwin-x64', 'linux-x64'] })
    expect(await newestRelease(source, 'linux-x64', signal)).toBe('1.0.0')
    mirror.publish({ version: '1.4.0', v2: 'absent' })
    expect(await newestRelease(source, 'linux-x64', signal)).toBe('1.4.0')
    expect(await newestRelease(source, 'darwin-x64', signal)).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('offers what this Host’s updater installs: an Intel Mac reads its v2 artifact', async () => {
  vi.useRealTimers()
  const root = mkdtempSync(join(tmpdir(), 'release-check-'))
  try {
    const mirror = localReleaseMirror(root)
    const source = { env: mirror.env, keys: mirror.keys }
    const signal = new AbortController().signal
    mirror.publish({ version: '1.3.0', targets: ['darwin-arm64', 'darwin-x64', 'linux-x64'] })
    expect(await newestRelease(source, 'darwin-x64', signal)).toBe('1.3.0')
    expect(await newestRelease(source, 'darwin-arm64', signal)).toBe('1.3.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('reads the manifests the updater reads: a v1-only mirror’s artifacts decide the offer', async () => {
  vi.useRealTimers()
  const root = mkdtempSync(join(tmpdir(), 'release-check-'))
  try {
    const mirror = localReleaseMirror(root)
    const source = { env: mirror.env, keys: mirror.keys }
    const signal = new AbortController().signal
    // A v1-only mirror without this machine's artifact offers nothing.
    mirror.publish({ version: '1.4.0', v2: 'absent', targets: ['linux-x64'] })
    expect(await newestRelease(source, 'darwin-arm64', signal)).toBeUndefined()
    expect(await newestRelease(source, 'linux-x64', signal)).toBe('1.4.0')
    // A broken v2 fails the check, as the updater refuses it; the last good answer stays.
    mirror.publish({ version: '1.5.0', v2: 'invalid', targets: ['linux-x64'] })
    await expect(newestRelease(source, 'linux-x64', signal)).rejects.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
