import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCodexUsageReader, parseCodexUsage } from './codex-usage'

vi.mock('./health', () => ({ checkPiHealth: vi.fn() }))
vi.mock('./stub', () => ({ piStubPath: () => undefined }))
vi.mock('./shell-env', () => ({ piProcessEnv: vi.fn() }))

const window = (used_percent = 48, limit_window_seconds = 604800) => ({
  used_percent,
  limit_window_seconds,
  reset_at: 1_791_948_694,
})
const payload = {
  rate_limit: { primary_window: window(), secondary_window: null },
  spend_control: {
    individual_limit: {
      unit: 'credit',
      limit: '200',
      remaining: '56.15',
      reset_at: 1_793_491_200,
    },
  },
}
const authOutput = (account = 'account-a') =>
  JSON.stringify({
    status: 'ready',
    authType: 'oauth',
    credentials: `header.${Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: account },
      }),
    ).toString('base64url')}.signature`,
  })
const request = () =>
  vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(payload)))

afterEach(() => vi.useRealTimers())

describe('Codex usage', () => {
  it('reads a weekly-only primary and workspace credits without guessing five-hour usage', () => {
    expect(parseCodexUsage(payload, 100)).toEqual({
      ok: true,
      snapshot: {
        fetchedAt: 100,
        windows: [
          { label: 'Weekly', kind: 'weekly', percentUsed: 48, resetsAt: 1_791_948_694_000 },
        ],
        credits: { limit: 200, remaining: 56.15, resetsAt: 1_793_491_200_000 },
      },
    })
  })

  it('supports both windows, zero usage, unknown durations and absent reset dates', () => {
    const result = parseCodexUsage({
      rate_limit: {
        primary_window: { ...window(0, 18000), reset_at: null },
        secondary_window: window(100, 7200),
      },
    })
    expect(result.ok && result.snapshot.windows).toEqual([
      { label: '5-hour', kind: 'five_hour', percentUsed: 0, resetsAt: null },
      { label: '2-hour', kind: 'other', percentUsed: 100, resetsAt: 1_791_948_694_000 },
    ])
  })

  it.each([
    null,
    {},
    { rate_limit: { primary_window: { used_percent: '48' } } },
    { rate_limit: { primary_window: window(-1) } },
    { rate_limit: { primary_window: window(101) } },
    { rate_limit: { primary_window: window(NaN) } },
    { rate_limit: { primary_window: window(48, 0) } },
    { credits: { balance: '20' } },
  ])('never fabricates zero usage for malformed/unsupported responses: %j', (input) => {
    expect(parseCodexUsage(input)).toEqual({ ok: false, error: 'no-usage' })
  })

  it('allows credit-only plans but rejects absent amounts and non-credit units', () => {
    expect(parseCodexUsage({ spend_control: payload.spend_control }).ok).toBe(true)
    for (const change of [
      { remaining: null },
      { remaining: '' },
      { remaining: -1 },
      { unit: 'usd' },
    ]) {
      expect(
        parseCodexUsage({
          spend_control: {
            individual_limit: {
              ...payload.spend_control.individual_limit,
              ...change,
            },
          },
        }),
      ).toEqual({ ok: false, error: 'no-usage' })
    }
  })

  it('uses a fixed endpoint, bearer and account header; never returns secrets or upstream identity', async () => {
    const fetcher = request()
    const read = createCodexUsageReader(async () => authOutput(), fetcher)
    const result = await read()
    expect(fetcher).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        Authorization: `Bearer ${JSON.parse(authOutput()).credentials}`,
        'ChatGPT-Account-Id': 'account-a',
      },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    })
    expect(JSON.stringify(result)).not.toMatch(/signature|account-a|credentials/)
  })

  it('deduplicates concurrent calls, caches 60 seconds and supports manual refresh', async () => {
    vi.useFakeTimers()
    const auth = vi.fn(async () => authOutput())
    const fetcher = request()
    const read = createCodexUsageReader(auth, fetcher)
    await Promise.all([read(), read(true)])
    expect(fetcher).toHaveBeenCalledTimes(1)
    await read()
    expect(auth).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await read(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60_001)
    await read()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('does not reuse usage across account changes or sign-out', async () => {
    const auth = vi
      .fn()
      .mockResolvedValueOnce(authOutput())
      .mockResolvedValueOnce(authOutput('account-b'))
      .mockResolvedValueOnce('{"status":"not_ready"}')
    const fetcher = request()
    const read = createCodexUsageReader(auth, fetcher)
    await read()
    await read()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await read()).toEqual({ ok: false, error: 'auth-unavailable' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([
    'invalid',
    '{"status":"ready","authType":"api_key","credentials":"secret"}',
    '{"status":"ready","authType":"oauth","credentials":"invalid"}',
  ])('does not send requests for invalid auth: %s', async (output) => {
    const fetcher = request()
    expect(await createCodexUsageReader(async () => output, fetcher)()).toEqual({
      ok: false,
      error: 'auth-unavailable',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'auth-unavailable'],
    [403, 'auth-unavailable'],
    [429, 'rate-limited'],
    [500, 'request-failed'],
  ] as const)('sanitizes HTTP %s and retries failures', async (status, error) => {
    const fetcher = request().mockResolvedValueOnce(new Response('secret', { status }))
    const read = createCodexUsageReader(async () => authOutput(), fetcher)
    expect(await read()).toEqual({ ok: false, error })
    expect((await read()).ok).toBe(true)
  })

  it('sanitizes subprocess, network and JSON errors', async () => {
    expect(
      await createCodexUsageReader(async () => {
        throw new Error('secret stdout')
      })(),
    ).toEqual({ ok: false, error: 'auth-unavailable' })
    for (const fetcher of [
      request().mockRejectedValue(new Error('secret')),
      request().mockResolvedValue(new Response('not json')),
    ]) {
      expect(await createCodexUsageReader(async () => authOutput(), fetcher)()).toEqual({
        ok: false,
        error: 'request-failed',
      })
    }
  })
})
