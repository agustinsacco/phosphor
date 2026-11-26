import { expect, it, vi } from 'vitest'
import { machineHandlers } from './machine'
import { usageAccounts } from '../../providers/machine-usage'

import type { DaemonHandlerDeps } from './index'

it('returns every provider and individual account outcome, but refuses a total failure', async () => {
  const usage = vi.fn(async () => [
    {
      id: 'a',
      label: 'First',
      status: 'ok',
      windows: [{ label: 'Current session', percentUsed: 25 }],
    },
    { id: 'b', label: 'Second', status: 'unavailable', reason: 'Usage probe timed out.' },
  ])
  const call = vi.fn(async () => ({
    ok: true,
    data: {
      providers: [
        { id: 'pi-claude-cli', name: 'Claude CLI', status: 'ready' },
        { id: 'openai-codex', name: 'Codex', status: 'ready' },
      ],
    },
  }))
  const ctx = { signal: new AbortController().signal } as never
  const run = machineHandlers({
    settingsOps: { settings: { usageAccounts: usage } },
    lanes: { calls: { call } },
  } as unknown as DaemonHandlerDeps)['machine.usage']!
  expect(await run({}, ctx)).toMatchObject({
    data: {
      accounts: [
        { id: 'a', status: 'ok' },
        { id: 'b', status: 'unavailable' },
      ],
      providers: [{ id: 'pi-claude-cli' }, { id: 'openai-codex', usage: 'usage not available' }],
    },
  })
  usage.mockResolvedValueOnce([
    { id: 'b', label: 'Second', status: 'unavailable', reason: 'Usage probe timed out.' },
  ])
  call.mockResolvedValueOnce({
    ok: true,
    data: { providers: [{ id: 'pi-claude-cli', name: 'Claude CLI', status: 'unknown' }] },
  })
  await expect(run({}, ctx)).rejects.toMatchObject({
    code: 'unavailable',
    message: expect.stringContaining('timed out'),
  })
})

it('lets one Claude deadline expire without losing a healthy account or Codex usage', async () => {
  vi.useFakeTimers()
  try {
    const accounts = {
      readMetadata: () => ({
        accounts: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      }),
      accountUsageEnv: () => ({}),
      usage: {
        fetchUsageSnapshot: vi.fn(async (a: { cacheKey: string }) =>
          a.cacheKey === 'a'
            ? new Promise(() => {})
            : {
                ok: true,
                snapshot: { windows: [], fetchedAt: 100, stale: false, contributing: 'private' },
              },
        ),
      },
    }
    const signal = new AbortController().signal
    const result = usageAccounts(accounts as never, signal)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(await result).toEqual([
      { id: 'a', label: 'A', status: 'unavailable', reason: 'Usage probe timed out after 12s.' },
      { id: 'b', label: 'B', status: 'ok', windows: [], fetchedAt: 100, stale: false },
    ])
    const codexUsage = vi.fn(async () => ({
      ok: true,
      snapshot: { fetchedAt: 100, windows: [], credits: null },
    }))
    const call = vi.fn(async () => ({
      ok: true,
      data: { providers: [{ id: 'openai-codex', name: 'Codex', status: 'ready' }] },
    }))
    const run = machineHandlers({
      settingsOps: { settings: { codexUsage, usageAccounts: async () => [] } },
      lanes: { calls: { call } },
    } as unknown as DaemonHandlerDeps)['machine.usage']!
    expect(await run({}, { signal } as never)).toMatchObject({
      data: { providers: [{ id: 'openai-codex', usage: { fetchedAt: 100 } }] },
    })
  } finally {
    vi.useRealTimers()
  }
})
