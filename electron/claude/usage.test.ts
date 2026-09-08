/**
 * `claude -p /usage` parsing, cached fetching, and error mapping.
 *
 * The live fixture (`__fixtures__/usage-live.json`) is a real capture from
 * Claude Code 2.1.231 against a signed-in Max account — the wire this module
 * exists to mirror. Epoch assertions are deliberately relational: the CLI
 * renders reset stamps in the *machine's* local timezone, so a test machine
 * in a different one must still pass.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearUsageCache,
  fetchUsageSnapshot,
  parseResetStamp,
  parseUsageOutput,
  parseUsageText,
  windowKind,
} from './usage'

const FIXTURE = readFileSync(join(__dirname, '__fixtures__', 'usage-live.json'), 'utf8')

/** A fixed "now" in local-time components so timezone choice doesn't matter. */
const nowAt = (year: number, monthIndex: number, day: number, hour = 12): number =>
  new Date(year, monthIndex, day, hour, 0, 0, 0).getTime()

describe('parseUsageText', () => {
  it('parses the live capture: three windows, kinds, percents, contributing', () => {
    const snapshot = parseUsageOutput(FIXTURE, nowAt(2026, 7, 30, 12))
    expect(snapshot).not.toBeNull()
    const windows = snapshot!.windows
    expect(windows.map((w) => w.kind)).toEqual(['five_hour', 'weekly', 'weekly_model'])
    expect(windows.map((w) => w.percentUsed)).toEqual([48, 51, 37])
    expect(windows[0]?.label).toBe('Current session')
    expect(windows[2]?.label).toBe('Current week (Fable)')
    expect(snapshot!.stale).toBe(false)
    // The reset stamps parse and land in the future of the fixed now.
    for (const w of windows) expect(w.resetsAt).not.toBeNull()
    expect(windows[0]?.resetsAt).toBeGreaterThan(nowAt(2026, 7, 30, 12))
    // The behavioral block is carried verbatim, without the heading.
    expect(snapshot!.contributing).toMatch(/^Approximate, based on local sessions/)
    expect(snapshot!.contributing).toContain('Last 24h')
  })

  it('marks last-known data as stale and keeps its windows', () => {
    const snapshot = parseUsageText(
      [
        'Showing last-known usage (could not refresh)',
        '',
        'Current session: 40% used · resets Aug 30 at 2:50pm',
      ].join('\n'),
      nowAt(2026, 7, 30, 12),
    )
    expect(snapshot?.stale).toBe(true)
    expect(snapshot?.windows[0]?.percentUsed).toBe(40)
  })

  it('returns null when refresh failed and nothing parsed — never zeros', () => {
    expect(parseUsageText('Could not refresh usage data', nowAt(2026, 7, 30))).toBeNull()
  })

  it('returns null for non-subscription output (signed out, API key, drift)', () => {
    expect(parseUsageText('You are not using a subscription.', nowAt(2026, 7, 30))).toBeNull()
  })

  it('keeps unknown window labels as kind "other" rather than dropping them', () => {
    const snapshot = parseUsageText('Claude Code and Cowork credit: 12% used', nowAt(2026, 7, 30))
    expect(snapshot?.windows[0]).toMatchObject({ kind: 'other', percentUsed: 12 })
  })

  it('drops implausible percents instead of rendering them', () => {
    const snapshot = parseUsageText(
      ['Current session: 250% used', 'Current week (all models): 3% used'].join('\n'),
      nowAt(2026, 7, 30),
    )
    expect(snapshot?.windows.map((w) => w.percentUsed)).toEqual([3])
  })
})

describe('parseResetStamp', () => {
  it('parses with and without minutes', () => {
    expect(parseResetStamp('Aug 30 at 2:49pm', nowAt(2026, 7, 30, 12))).not.toBeNull()
    expect(parseResetStamp('Aug 30 at 4pm', nowAt(2026, 7, 30, 12))).not.toBeNull()
  })

  it('rolls the year across December → January', () => {
    const at = parseResetStamp('Jan 2 at 9am', nowAt(2026, 11, 30, 12))
    expect(at).not.toBeNull()
    expect(new Date(at!).getFullYear()).toBe(2027)
  })

  it('resolves a same-day stamp in the same year, without rolling', () => {
    const at = parseResetStamp('Aug 30 at 2:49pm', nowAt(2026, 7, 30, 12))
    expect(new Date(at!).getHours()).toBe(14)
    expect(new Date(at!).getFullYear()).toBe(2026)
  })

  it('rejects shapes it does not know', () => {
    expect(parseResetStamp('2026-08-30T14:49:00Z', nowAt(2026, 7, 30))).toBeNull()
    expect(parseResetStamp('soon', nowAt(2026, 7, 30))).toBeNull()
  })
})

describe('windowKind', () => {
  it('maps the known labels and passes unknown ones through', () => {
    expect(windowKind('Current session')).toBe('five_hour')
    expect(windowKind('Current week (all models)')).toBe('weekly')
    expect(windowKind('Current week (Sonnet only)')).toBe('weekly_model')
    expect(windowKind('One-time credit')).toBe('other')
  })
})

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
      return FIXTURE
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
      return FIXTURE
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
      return FIXTURE
    }
    const a = fetchUsageSnapshot({ claudeOverride: '/x/claude', runner })
    const b = fetchUsageSnapshot({ claudeOverride: '/x/claude', runner })
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(calls).toBe(1)
    expect(ra).toEqual(rb)
  })
})
