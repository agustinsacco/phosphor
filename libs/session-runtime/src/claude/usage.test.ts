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
import { describe, expect, it, vi } from 'vitest'
import {
  createClaudeUsage,
  parseResetStamp,
  parseUsageOutput,
  parseUsageText,
  windowKind,
  type ClaudeUsagePorts,
} from './usage'

const FIXTURE = readFileSync(join(__dirname, '__fixtures__', 'usage-live.json'), 'utf8')

/** A fixed "now" in local-time components so timezone choice doesn't matter. */
const nowAt = (year: number, monthIndex: number, day: number, hour = 12): number =>
  new Date(year, monthIndex, day, hour, 0, 0, 0).getTime()

const output = JSON.stringify({ result: 'Current session: 20% used' })
function domain(overrides: Partial<ClaudeUsagePorts> = {}) {
  const binary = vi.fn(async () => '/trusted/claude')
  const environment = vi.fn(async () => ({ PATH: '/trusted', MACHINE: 'host' }))
  const run = vi.fn<ClaudeUsagePorts['run']>(async () => output)
  return {
    binary,
    environment,
    run,
    service: createClaudeUsage({ binary, environment, run, ...overrides }),
  }
}

it('keeps cache keys and execution machines isolated, merges probe env and expires exactly at the TTL', async () => {
  const a = domain()
  const b = domain()
  const first = await a.service.fetchUsageSnapshot({
    cacheKey: 'a',
    nowMs: 1000,
    extraEnv: { MACHINE: 'account', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/private/a' },
  })
  expect(first.ok).toBe(true)
  expect(a.run).toHaveBeenCalledExactlyOnceWith('/trusted/claude', {
    PATH: '/trusted',
    MACHINE: 'account',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/private/a',
  })
  expect(a.service.cachedUsageSnapshot('a', 60_999)).not.toBeNull()
  expect(a.service.cachedUsageSnapshot('a', 61_000)).toBeNull()
  expect(a.service.cachedUsageSnapshot('b', 1000)).toBeNull()
  expect(b.service.cachedUsageSnapshot('a', 1000)).toBeNull()
  expect(a.run).toHaveBeenCalledTimes(1)
  await a.service.fetchUsageSnapshot({ cacheKey: 'b', nowMs: 1000 })
  await a.service.fetchUsageSnapshot({ cacheKey: 'a', nowMs: 61_000 })
  expect(a.run).toHaveBeenCalledTimes(3)
  a.service.clearUsageCache('a')
  expect(a.service.cachedUsageSnapshot('a', 61_000)).toBeNull()
  expect(a.service.cachedUsageSnapshot('b', 1000)).not.toBeNull()
  a.service.clearUsageCache()
  expect(a.service.cachedUsageSnapshot('b', 1000)).toBeNull()
  expect(b.run).not.toHaveBeenCalled()
})

it('shares forced in-flight requests for one key, without blocking other accounts', async () => {
  let release!: (value: string) => void
  const pending = new Promise<string>((resolve) => {
    release = resolve
  })
  const d = domain()
  d.run.mockImplementationOnce(() => pending)
  const a = d.service.fetchUsageSnapshot({ cacheKey: 'a', nowMs: 1000 })
  const forced = d.service.fetchUsageSnapshot({ cacheKey: 'a', force: true, nowMs: 1001 })
  const b = await d.service.fetchUsageSnapshot({ cacheKey: 'b', nowMs: 1000 })
  expect(b.ok).toBe(true)
  expect(d.run).toHaveBeenCalledTimes(2)
  release(output)
  expect(await forced).toEqual(await a)
  await d.service.fetchUsageSnapshot({ cacheKey: 'a', force: true, nowMs: 1002 })
  expect(d.run).toHaveBeenCalledTimes(3)
})

it('preserves errors, retries failures and bypasses binary resolution for an explicit override', async () => {
  const d = domain({ binary: async () => null })
  expect(await d.service.fetchUsageSnapshot()).toEqual({ ok: false, error: 'claude-not-found' })
  expect(d.environment).not.toHaveBeenCalled()
  const options = { claudeOverride: '/override/claude', nowMs: 1000 }
  d.run.mockResolvedValueOnce(null).mockResolvedValueOnce('not json')
  expect(await d.service.fetchUsageSnapshot(options)).toEqual({ ok: false, error: 'run-failed' })
  expect(await d.service.fetchUsageSnapshot(options)).toEqual({ ok: false, error: 'no-usage' })
  expect((await d.service.fetchUsageSnapshot(options)).ok).toBe(true)
  expect(d.run).toHaveBeenCalledTimes(3)
  const rejecting = domain()
  rejecting.run.mockRejectedValueOnce(new Error('probe failed'))
  await expect(rejecting.service.fetchUsageSnapshot()).rejects.toThrow('probe failed')
  expect((await rejecting.service.fetchUsageSnapshot()).ok).toBe(true)
  expect(rejecting.run).toHaveBeenCalledTimes(2)
})

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

  it('parses the comma form of Claude Code 2.1.283', () => {
    const at = parseResetStamp('Oct 25, 7:59pm', nowAt(2026, 9, 19, 2))
    expect(at).toBe(new Date(2026, 9, 25, 19, 59, 0, 0).getTime())
    expect(parseResetStamp('Oct 25, 8pm', nowAt(2026, 9, 19, 2))).not.toBeNull()
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
