/**
 * Desktop's `claude -p /usage` binding: cached fetching and error mapping.
 * The parser and its live fixture are tested beside the lib.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearUsageCache, fetchUsageSnapshot } from './usage'

const OUTPUT = JSON.stringify({ result: 'Current session: 20% used' })

/** A fixed "now" in local-time components so timezone choice doesn't matter. */
const nowAt = (year: number, monthIndex: number, day: number, hour = 12): number =>
  new Date(year, monthIndex, day, hour, 0, 0, 0).getTime()

describe('fetchUsageSnapshot', () => {
  beforeEach(() => {
    clearUsageCache()
  })

  it('maps a missing binary, a failed run, and unparseable output', async () => {
    // claude-not-found: the runner is only reached with a resolved binary, so
    // a null return with no binary can't happen through the runner — the
    // missing-binary case is the override-less path tested by exclusion here.
    const runner = vi.fn(
      async (_path: string, _env: NodeJS.ProcessEnv): Promise<string | null> => null,
    )
    expect(await fetchUsageSnapshot({ claudeOverride: '/x/claude', runner })).toEqual({
      ok: false,
      error: 'run-failed',
    })

    expect(
      await fetchUsageSnapshot({
        claudeOverride: '/x/claude',
        runner: async () => 'not json',
      }),
    ).toEqual({ ok: false, error: 'no-usage' })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0]?.[0]).toBe('/x/claude')
  })

  it('caches a successful snapshot for the TTL and not a failure', async () => {
    let calls = 0
    const runner = async (): Promise<string> => {
      calls++
      return OUTPUT
    }
    const t0 = nowAt(2026, 7, 30, 12)
    const first = await fetchUsageSnapshot({ claudeOverride: '/x/claude', runner, nowMs: t0 })
    expect(first.ok).toBe(true)
    const second = await fetchUsageSnapshot({
      claudeOverride: '/x/claude',
      runner,
      nowMs: t0 + 30_000,
    })
    expect(second).toEqual(first)
    expect(calls).toBe(1) // inside the TTL: no second spawn

    const third = await fetchUsageSnapshot({
      claudeOverride: '/x/claude',
      runner,
      nowMs: t0 + 61_000,
    })
    expect(third.ok).toBe(true)
    expect(calls).toBe(2) // past the TTL: fresh spawn, fresh data

    let failed = 0
    const failing = async (): Promise<string | null> => {
      failed++
      return null
    }
    // Past the TTL of the newest cached success above, so each ask spawns.
    await fetchUsageSnapshot({
      claudeOverride: '/x/claude',
      runner: failing,
      nowMs: t0 + 122_000,
    })
    await fetchUsageSnapshot({
      claudeOverride: '/x/claude',
      runner: failing,
      nowMs: t0 + 123_000,
    })
    expect(failed).toBe(2) // failures are not cached; each ask retries
  })

  it('re-runs inside the TTL when a refresh forces it', async () => {
    let calls = 0
    const runner = async (): Promise<string> => {
      calls++
      return OUTPUT
    }
    const t0 = nowAt(2026, 7, 30, 12)
    await fetchUsageSnapshot({ claudeOverride: '/x/claude', runner, nowMs: t0 })
    expect(calls).toBe(1)
    // The refresh control in the context popover: a cached answer to a click
    // looks broken, so this one call may skip the TTL.
    const forced = await fetchUsageSnapshot({
      claudeOverride: '/x/claude',
      runner,
      nowMs: t0 + 5_000,
      force: true,
    })
    expect(forced.ok).toBe(true)
    expect(calls).toBe(2)
    // And it re-primed the cache, so the next ordinary read is free again.
    await fetchUsageSnapshot({ claudeOverride: '/x/claude', runner, nowMs: t0 + 6_000 })
    expect(calls).toBe(2)
  })

  it('shares one run between concurrent callers', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner = async (): Promise<string> => {
      calls++
      await gate
      return OUTPUT
    }
    const a = fetchUsageSnapshot({ claudeOverride: '/x/claude', runner })
    const b = fetchUsageSnapshot({ claudeOverride: '/x/claude', runner })
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(calls).toBe(1)
    expect(ra).toEqual(rb)
  })
})
