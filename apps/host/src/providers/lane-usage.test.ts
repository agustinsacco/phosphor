import { expect, it, vi } from 'vitest'
import type {
  ClaudeAccount,
  ClaudeAccountPrefs,
  ClaudeUsageSnapshot,
} from '@phosphor/shared/models'
import { createClaudeUsage } from '@phosphor/session-runtime/claude/usage'
import { createLaneUsage, USAGE_FORCE_FLOOR_MS } from './lane-usage'

const account = (id: string): ClaudeAccount => ({ id, label: id }) as ClaudeAccount
const prefs = (over: Partial<ClaudeAccountPrefs> = {}): ClaudeAccountPrefs =>
  ({
    accounts: [account('a'), account('b')],
    bindings: {},
    cooldowns: {},
    cursor: 0,
    mode: 'round-robin',
    ...over,
  }) as ClaudeAccountPrefs
const snapshot: ClaudeUsageSnapshot = {
  fetchedAt: 1,
  stale: false,
  windows: [{ label: 'Current session', kind: 'five_hour', percentUsed: 3, resetsAt: null }],
  contributing: 'Mostly /home/me/private-repo',
}

function setup(stored: ClaudeAccountPrefs, bound?: string) {
  const fetchUsageSnapshot = vi.fn(async () => ({ ok: true as const, snapshot }))
  const cachedUsageSnapshot = vi.fn((): ClaudeUsageSnapshot | null => null)
  const accountUsageEnv = vi.fn((a: ClaudeAccount) => ({ CLAUDE_CONFIG_DIR: `/usage/${a.id}` }))
  const accountForLane = vi.fn(() => bound)
  const read = createLaneUsage({
    accounts: {
      loadAccounts: async () => stored,
      accountUsageEnv,
      usage: { fetchUsageSnapshot, cachedUsageSnapshot } as never,
    },
    accountForLane,
  })
  return { read, fetchUsageSnapshot, cachedUsageSnapshot, accountForLane }
}

it("reads the lane's bound account and never returns the contributing text", async () => {
  const t = setup(prefs(), 'b')
  expect(await t.read('lane', false, 100)).toEqual({
    ok: true,
    snapshot: { ...snapshot, contributing: null },
  })
  expect(t.accountForLane).toHaveBeenCalledWith('lane', prefs())
  expect(t.fetchUsageSnapshot).toHaveBeenCalledWith({
    cacheKey: 'b',
    extraEnv: { CLAUDE_CONFIG_DIR: '/usage/b' },
    force: false,
    nowMs: 100,
  })
})

it('falls back to the pinned, then first account, then the default login', async () => {
  const pinned = setup(prefs({ pinnedId: 'b' }), 'gone')
  await pinned.read('lane', false, 100)
  expect(pinned.fetchUsageSnapshot).toHaveBeenCalledWith(expect.objectContaining({ cacheKey: 'b' }))
  const first = setup(prefs())
  await first.read(undefined, false, 100)
  expect(first.accountForLane).not.toHaveBeenCalled()
  expect(first.fetchUsageSnapshot).toHaveBeenCalledWith(expect.objectContaining({ cacheKey: 'a' }))
  const none = setup(prefs({ accounts: [] }))
  await none.read('lane', true, 100)
  expect(none.fetchUsageSnapshot).toHaveBeenCalledWith({ force: true, nowMs: 100 })
})

it('ignores a forced refresh within the floor of the last reading', async () => {
  const t = setup(prefs())
  t.cachedUsageSnapshot.mockReturnValue({ ...snapshot, fetchedAt: 1000 })
  await t.read('lane', true, 1000 + USAGE_FORCE_FLOOR_MS - 1)
  expect(t.fetchUsageSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ force: false }))
  await t.read('lane', true, 1000 + USAGE_FORCE_FLOOR_MS)
  expect(t.fetchUsageSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))
})

it('passes CLI failures through unchanged', async () => {
  const t = setup(prefs())
  t.fetchUsageSnapshot.mockResolvedValueOnce({ ok: false, error: 'no-usage' } as never)
  expect(await t.read('lane', false)).toEqual({ ok: false, error: 'no-usage' })
})

it('serves only the failed account’s last known windows without renewing their age', async () => {
  const run = vi.fn<() => Promise<string | null>>().mockResolvedValue(null)
  const output = (percent: number) =>
    JSON.stringify({
      result: `Current session: ${percent}% used\nWhat's contributing to your limits usage?\nprivate`,
    })
  const usage = createClaudeUsage({
    binary: async () => '/stub',
    environment: async () => ({}),
    run,
  })
  const read = createLaneUsage({
    accounts: { loadAccounts: async () => prefs(), accountUsageEnv: () => ({}), usage },
    accountForLane: (laneId) => laneId,
  })
  run.mockResolvedValueOnce(output(3))
  expect(await read('a', false, 1)).toEqual({
    ok: true,
    snapshot: { ...snapshot, contributing: null },
  })
  expect(await read('b', false, 61_000)).toEqual({ ok: false, error: 'run-failed' })
  expect(await read('a', false, 61_000)).toEqual({
    ok: true,
    snapshot: { ...snapshot, stale: true, contributing: null },
  })
  run.mockResolvedValueOnce(output(5))
  expect(await read('a', false, 61_001)).toMatchObject({
    ok: true,
    snapshot: { fetchedAt: 61_001, stale: false, windows: [{ percentUsed: 5 }] },
  })
})
