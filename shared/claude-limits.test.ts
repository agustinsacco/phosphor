import { describe, expect, it } from 'vitest'
import { accountExhaustedUntil } from './claude-limits'

const NOW = 1_800_000_000_000
const payload = (fields: Record<string, unknown>): string => JSON.stringify(fields)

describe('accountExhaustedUntil', () => {
  it('leaves a healthy account alone', () => {
    expect(accountExhaustedUntil(payload({ status: 'allowed', utilization: 0.42 }), NOW)).toBeNull()
  })

  it('holds an account the API is rejecting', () => {
    const until = accountExhaustedUntil(
      payload({ status: 'rejected', resetsAt: NOW / 1000 + 600 }),
      NOW,
    )
    expect(until).toBe(NOW + 600_000)
  })

  it('holds an account spending overage credits, even while requests succeed', () => {
    // The case this module exists for: the plan is gone, the CLI keeps working,
    // and every further token is billed at API rates.
    const until = accountExhaustedUntil(
      payload({ status: 'allowed', isUsingOverage: true, rateLimitType: 'overage' }),
      NOW,
    )
    expect(until).toBe(NOW + 5 * 60 * 60 * 1000)
  })

  it('holds an account at or past its window', () => {
    expect(accountExhaustedUntil(payload({ utilization: 1 }), NOW)).toBe(NOW + 5 * 60 * 60 * 1000)
    expect(accountExhaustedUntil(payload({ utilization: 1.4 }), NOW)).not.toBeNull()
    expect(accountExhaustedUntil(payload({ utilization: 0.99 }), NOW)).toBeNull()
  })

  it('treats an elapsed reset as stale rather than exhausted', () => {
    expect(
      accountExhaustedUntil(payload({ status: 'rejected', resetsAt: NOW / 1000 - 60 }), NOW),
    ).toBeNull()
  })

  it('never throws on a payload it does not recognise', () => {
    expect(accountExhaustedUntil(undefined, NOW)).toBeNull()
    expect(accountExhaustedUntil('not json', NOW)).toBeNull()
    expect(accountExhaustedUntil('null', NOW)).toBeNull()
    expect(accountExhaustedUntil(payload({}), NOW)).toBeNull()
  })
})
