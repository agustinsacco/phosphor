import { expect, it, vi } from 'vitest'
import { createClaudeUsage, type ClaudeUsagePorts } from './usage'

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
