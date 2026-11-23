import { describe, expect, it } from 'vitest'
import type { HostReleaseManifestV2 } from '@phosphor/shared/host-release'
import {
  MANIFEST_JITTER_MS,
  MANIFEST_RETRY_MS,
  createManifestWatch,
  releaseReadiness,
} from './manifest-watch'

const release: HostReleaseManifestV2 = {
  schema: 2,
  version: '1.2.3',
  protocols: [1],
  node: '24.14.1',
  sourceCommit: 'a'.repeat(40),
  features: ['local-mode', 'owner-socket', 'ops'],
  artifacts: [{ target: 'darwin-x64', file: 'f', bytes: 1, sha256: 'a'.repeat(64) }],
}

describe('releaseReadiness', () => {
  it('is ready only with both features, this target and our protocol', () => {
    expect(releaseReadiness({ manifest: 2, release }, 'darwin-x64', 1)).toEqual({
      ready: true,
      release,
      artifact: release.artifacts[0],
    })
  })
  it.each([
    ['no v2 manifest', { manifest: 1 as const, version: '1.2.3' }, 'darwin-x64', 'no-v2'],
    [
      'only one feature',
      { manifest: 2 as const, release: { ...release, features: ['local-mode'] } },
      'darwin-x64',
      'no-features',
    ],
    ['no artifact for this Mac', { manifest: 2 as const, release }, 'darwin-arm64', 'no-artifact'],
    [
      'another protocol',
      { manifest: 2 as const, release: { ...release, protocols: [2] } },
      'darwin-x64',
      'protocol',
    ],
  ])('waits on %s', (_name, check, target, reason) => {
    expect(releaseReadiness(check, target, 1)).toMatchObject({ ready: false, reason })
  })
})

function harness(outcomes: ('retry' | 'done' | 'throw')[]) {
  let clock = 0
  const timers: { at: number; run: () => void; live: boolean }[] = []
  const signals: AbortSignal[] = []
  let release: (() => void) | null = null
  const watch = createManifestWatch({
    now: () => clock,
    random: () => 0.5,
    setTimer: (run, ms) => {
      const timer = { at: clock + ms, run, live: true }
      timers.push(timer)
      return () => (timer.live = false)
    },
    attempt: (signal) => {
      signals.push(signal)
      const outcome = outcomes.shift() ?? 'retry'
      if (outcome === 'throw') return Promise.reject(new Error('offline'))
      return new Promise((resolve) => (release = () => resolve(outcome)))
    },
  })
  const finish = async () => {
    release?.()
    release = null
    await new Promise((resolve) => setImmediate(resolve))
  }
  const advance = (ms: number) => {
    clock += ms
    for (const timer of timers.filter((t) => t.live && t.at <= clock)) {
      timer.live = false
      timer.run()
    }
  }
  return { watch, signals, finish, advance, timers, now: () => clock }
}

describe('createManifestWatch', () => {
  it('checks at start, then every 30 minutes with jitter until done', async () => {
    const h = harness(['retry', 'retry', 'done'])
    h.watch.start()
    expect(h.signals).toHaveLength(1)
    expect(h.watch.nextAt()).toBeNull()
    await h.finish()
    const delay = MANIFEST_RETRY_MS + MANIFEST_JITTER_MS / 2
    expect(h.watch.nextAt()).toBe(delay)
    h.advance(delay - 1)
    expect(h.signals).toHaveLength(1)
    h.advance(1)
    expect(h.signals).toHaveLength(2)
    await h.finish()
    h.advance(delay)
    await h.finish()
    expect(h.signals).toHaveLength(3)
    expect(h.watch.nextAt()).toBeNull()
    h.advance(10 * delay)
    expect(h.signals).toHaveLength(3)
  })
  it('treats a failed attempt as a retry', async () => {
    const h = harness(['throw'])
    h.watch.start()
    await h.finish()
    expect(h.watch.nextAt()).not.toBeNull()
  })
  it('checks on focus only once 30 minutes have passed, and never twice at once', async () => {
    const h = harness([])
    h.watch.start()
    h.watch.focus()
    expect(h.signals).toHaveLength(1)
    await h.finish()
    h.advance(MANIFEST_RETRY_MS - 1)
    h.watch.focus()
    expect(h.signals).toHaveLength(1)
    h.advance(1)
    h.watch.focus()
    expect(h.signals).toHaveLength(2)
    // The focus attempt replaced the pending timer.
    h.advance(MANIFEST_JITTER_MS)
    expect(h.signals).toHaveLength(2)
  })
  it('stop aborts the running attempt and schedules nothing more', async () => {
    const h = harness([])
    h.watch.start()
    h.watch.stop()
    expect(h.signals[0]?.aborted).toBe(true)
    await h.finish()
    h.advance(10 * MANIFEST_RETRY_MS)
    h.watch.focus()
    expect(h.signals).toHaveLength(1)
    expect(h.watch.nextAt()).toBeNull()
  })
})
